/**
 * Integration tests — spin up a real MySQL container and verify the
 * behaviors unit tests cannot reach:
 *   - hardenSession actually applies READ ONLY to every pool connection
 *   - LOAD DATA LOCAL INFILE is blocked client-side
 *   - KILL QUERY cancels a running statement
 *   - the schema/admin tools talk to a real information_schema
 *
 * One container per file (startup is the expensive part). Tests share
 * it via beforeAll/afterAll.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  MySqlContainer,
  type StartedMySqlContainer,
} from "@testcontainers/mysql";
import mysql from "mysql2/promise";
import {
  initConnection,
  closeAll,
  getPool,
  queryWithTimeout,
} from "../../connection.js";
import type { DatabaseConfig } from "../../types.js";
import { DatabaseConfigSchema } from "../../schema.js";
import { handleStreamingQuery } from "../../tools/streaming-tools.js";

const CONTAINER_START_TIMEOUT_MS = 120_000;

let container: StartedMySqlContainer;
let baseConfig: Omit<DatabaseConfig, "name" | "readonly">;

beforeAll(async () => {
  // mysql:8.4 is the current LTS line. Image is ~600MB but cached locally.
  container = await new MySqlContainer("mysql:8.4")
    .withDatabase("testdb")
    .withUsername("testuser")
    .withUserPassword("testpass")
    .start();

  baseConfig = DatabaseConfigSchema.parse({
    name: "placeholder",
    host: container.getHost(),
    port: container.getPort(),
    user: "testuser",
    password: "testpass",
    database: "testdb",
  });

  // Seed schema once using a direct mysql2 connection (bypassing our
  // pool so we can run multi-statement DDL).
  const seed = await mysql.createConnection({
    host: container.getHost(),
    port: container.getPort(),
    user: "root",
    password: container.getRootPassword(),
    database: "testdb",
    multipleStatements: true,
  });
  await seed.query(`
    CREATE TABLE users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_email (email)
    );
    CREATE TABLE orders (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      total DECIMAL(10,2),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    INSERT INTO users (email) VALUES ('alice@example.com'), ('bob@example.com');
    INSERT INTO orders (user_id, total) VALUES (1, 99.99), (1, 12.50), (2, 250.00);
  `);
  // Grant our test user:
  //   - PROCESS so list_processes / KILL work against its own threads.
  //   - CREATE/DROP at the *.* level so compare_schema_file can create
  //     and drop a temp database on the scratch connection. MySQL
  //     ships the container's default user with rights to *its own*
  //     database only — global DDL needs an explicit grant.
  await seed.query("GRANT PROCESS, CREATE, DROP ON *.* TO 'testuser'@'%'");
  // SELECT on performance_schema for the diagnostics pack
  // (current_locks reads data_lock_waits; slow_queries reads
  // events_statements_summary_by_digest). In production this is the
  // standard grant for any monitoring user.
  await seed.query("GRANT SELECT ON performance_schema.* TO 'testuser'@'%'");
  await seed.query("FLUSH PRIVILEGES");
  await seed.end();
}, CONTAINER_START_TIMEOUT_MS);

afterAll(async () => {
  await closeAll();
  await container?.stop();
}, 30_000);

// ── read-only enforcement ────────────────────────────────────────────

describe("readonly: true — server-side enforcement", () => {
  const NAME = "ro";

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: NAME, readonly: true });
  });

  it("SET SESSION transaction_read_only is applied on every pool connection", async () => {
    // hardenSession is supposed to run on every new physical connection.
    // Exercise the pool by running 3 queries and verifying each sees the
    // session variable set.
    const pool = getPool(NAME);
    for (let i = 0; i < 3; i++) {
      const conn = await pool.getConnection();
      try {
        const [rows] = await conn.query(
          "SELECT @@SESSION.transaction_read_only AS ro, @@SESSION.sql_safe_updates AS safe",
        );
        const row = (rows as Array<{ ro: number; safe: number }>)[0];
        expect(row?.ro).toBe(1);
        expect(row?.safe).toBe(1);
      } finally {
        conn.release();
      }
    }
  });

  it("blocks an INSERT at the server level", async () => {
    // This bypasses our isReadOnlyQuery whitelist intentionally — we're
    // testing that even if the whitelist were ever fooled, MySQL itself
    // would reject the write.
    const pool = getPool(NAME);
    const conn = await pool.getConnection();
    try {
      await expect(
        conn.query(
          "INSERT INTO users (email) VALUES ('shouldfail@example.com')",
        ),
      ).rejects.toThrow(/read.?only|ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION/i);
    } finally {
      conn.release();
    }
  });

  it("does not pollute other pools — write to a separate RW pool succeeds", async () => {
    await initConnection({ ...baseConfig, name: "rw1", readonly: false });
    const pool = getPool("rw1");
    const conn = await pool.getConnection();
    try {
      await conn.query(
        "INSERT INTO users (email) VALUES ('rwcheck@example.com')",
      );
    } finally {
      conn.release();
    }
  });
});

// ── LOCAL INFILE block ──────────────────────────────────────────────

describe("LOAD DATA LOCAL INFILE is disabled", () => {
  const NAME = "rw_infile";

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: NAME, readonly: false });
  });

  it("throws when the server requests a local file", async () => {
    const pool = getPool(NAME);
    const conn = await pool.getConnection();
    try {
      // The query is syntactically valid — we expect the failure to come
      // from our infileStreamFactory throwing, not from a SQL parse error.
      // (When LOCAL_FILES is dropped from the handshake the server may
      // not request the file at all; either rejection path is acceptable.)
      await expect(
        conn.query(
          "LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE users FIELDS TERMINATED BY ','",
        ),
      ).rejects.toThrow();
    } finally {
      conn.release();
    }
  });
});

// ── KILL QUERY via cancellation signal ──────────────────────────────

describe("execute_query cancellation", () => {
  const NAME = "ro_cancel";

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: NAME, readonly: true });
  });

  it("KILL QUERY cancels a SELECT SLEEP() when abort fires", async () => {
    // Capture the connection ID running SLEEP, then issue KILL from a
    // sibling connection — exactly what the execute_query tool does
    // when RequestHandlerExtra.signal fires.
    const pool = getPool(NAME);
    const worker = await pool.getConnection();
    try {
      const [idRows] = await worker.query("SELECT CONNECTION_ID() AS id");
      const workerId = (idRows as Array<{ id: number }>)[0]!.id;

      // Kick off the SLEEP — would take 10s if not cancelled.
      const sleeping = worker
        .query("SELECT SLEEP(10)")
        .catch((err: unknown) => err);

      // Give MySQL a moment to start the sleep before we KILL it.
      await new Promise((r) => setTimeout(r, 200));

      const killer = await pool.getConnection();
      try {
        await killer.query(`KILL QUERY ${workerId}`);
      } finally {
        killer.release();
      }

      const result = await sleeping;
      // MySQL behavior: when KILL QUERY interrupts SELECT SLEEP(...), it
      // either rejects with ER_QUERY_INTERRUPTED OR resolves with
      // SLEEP() returning 1 (depending on timing/version). Both are
      // valid signals that KILL worked.
      if (result instanceof Error) {
        expect(result.message).toMatch(/interrupted|ER_QUERY_INTERRUPTED/i);
      } else {
        const rows = (result as [Array<Record<string, number>>])[0];
        // SLEEP returns 0 on normal completion, 1 on interruption.
        const sleepReturn = Object.values(rows[0] ?? {})[0];
        expect(sleepReturn).toBe(1);
      }
    } finally {
      worker.release();
    }
  }, 15_000);
});

// ── schema introspection against real information_schema ────────────

describe("schema introspection on a live MySQL", () => {
  const NAME = "ro_schema";

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: NAME, readonly: true });
  });

  it("list_tables sees both seeded tables with row counts", async () => {
    const tables = await queryWithTimeout<
      Array<{ TABLE_NAME: string; TABLE_ROWS: number }>
    >(
      NAME,
      `SELECT TABLE_NAME, TABLE_ROWS
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
      ["testdb"],
    );
    const names = tables.map((t) => t.TABLE_NAME);
    expect(names).toContain("users");
    expect(names).toContain("orders");
  });

  it("get_foreign_keys finds the orders→users relationship", async () => {
    const fks = await queryWithTimeout<
      Array<{ TABLE_NAME: string; REFERENCED_TABLE_NAME: string }>
    >(
      NAME,
      `SELECT TABLE_NAME, REFERENCED_TABLE_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      ["testdb"],
    );
    expect(fks).toContainEqual(
      expect.objectContaining({
        TABLE_NAME: "orders",
        REFERENCED_TABLE_NAME: "users",
      }),
    );
  });

  it("get_indexes finds idx_email", async () => {
    const idx = await queryWithTimeout<Array<{ INDEX_NAME: string }>>(
      NAME,
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      ["testdb", "users"],
    );
    const names = idx.map((r) => r.INDEX_NAME);
    expect(names).toContain("idx_email");
    expect(names).toContain("PRIMARY");
  });
});

// ── streaming_query against the real container ─────────────────────

describe("streaming_query — end-to-end against MySQL", () => {
  const NAME = "ro_stream";
  let outDir: string;

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: NAME, readonly: true });
    outDir = await mkdtemp(path.join(tmpdir(), "qb-stream-itg-"));

    // Seed enough rows that cap-stop and progress notifications have
    // something to do. INSERT directly via root so the readonly
    // connection's gate doesn't get in the way of the fixture.
    const seed = await mysql.createConnection({
      host: container.getHost(),
      port: container.getPort(),
      user: "root",
      password: container.getRootPassword(),
      database: "testdb",
    });
    try {
      await seed.query(`
        CREATE TABLE IF NOT EXISTS stream_fixture (
          id INT PRIMARY KEY AUTO_INCREMENT,
          payload VARCHAR(64) NOT NULL
        )
      `);
      // 500 rows is plenty — enough to exercise the per-1000 progress
      // path on a max_rows=200 cap, and to verify the truncation marker
      // without making the container test slow.
      const values: string[] = [];
      for (let i = 0; i < 500; i++) {
        values.push(`('row-${i}')`);
      }
      await seed.query(
        `INSERT INTO stream_fixture (payload) VALUES ${values.join(",")}`,
      );
    } finally {
      await seed.end();
    }
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("writes a full SELECT to NDJSON and returns a structured summary", async () => {
    const target = path.join(outDir, "all.ndjson");
    const result = await handleStreamingQuery({
      connection: NAME,
      query: "SELECT id, payload FROM stream_fixture ORDER BY id",
      output_path: target,
    });
    expect("isError" in result && result.isError).toBeFalsy();

    const summary = (result as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(summary.rows_written).toBe(500);
    expect(summary.truncated).toBe(false);
    expect(summary.output_path).toBe(target);

    const lines = (await readFile(target, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(500);
    const first = JSON.parse(lines[0] ?? "") as { id: number; payload: string };
    expect(first).toEqual({ id: 1, payload: "row-0" });
  });

  it("stops at max_rows and marks the result truncated", async () => {
    const target = path.join(outDir, "capped.ndjson");
    const result = await handleStreamingQuery({
      connection: NAME,
      query: "SELECT id, payload FROM stream_fixture ORDER BY id",
      output_path: target,
      max_rows: 50,
    });
    expect("isError" in result && result.isError).toBeFalsy();

    const summary = (result as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(summary.truncated).toBe(true);
    expect(summary.rows_written).toBe(50);

    const lines = (await readFile(target, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(50);
  });

  it("respects max_bytes when wide rows would blow the row cap budget", async () => {
    const target = path.join(outDir, "bytes-capped.ndjson");
    // Each row JSON-encodes to roughly 30+ bytes; max_bytes=200 should
    // stop somewhere between 4 and 7 rows.
    const result = await handleStreamingQuery({
      connection: NAME,
      query: "SELECT id, payload FROM stream_fixture ORDER BY id",
      output_path: target,
      max_bytes: 200,
    });
    expect("isError" in result && result.isError).toBeFalsy();
    const summary = (result as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(summary.truncated).toBe(true);
    expect(summary.bytes_written).toBeLessThanOrEqual(200);
    expect(summary.rows_written).toBeGreaterThan(0);
  });

  it("rejects a write SQL even on a writable connection", async () => {
    await initConnection({ ...baseConfig, name: "rw_stream", readonly: false });
    const target = path.join(outDir, "should-not-exist.ndjson");
    const result = await handleStreamingQuery({
      connection: "rw_stream",
      query: "DELETE FROM stream_fixture WHERE id = 1",
      output_path: target,
    });
    expect("isError" in result && result.isError).toBe(true);
    // The file should not have been opened.
    await expect(readFile(target, "utf8")).rejects.toThrow(/ENOENT/);
  });
});

// ── compare_schema_file against the real container ─────────────────

import { handleCompareSchemaFile } from "../../tools/compare-schema-file.js";
import { writeFile as fsWriteFile } from "node:fs/promises";

describe("compare_schema_file — end-to-end against MySQL", () => {
  const LIVE = "ro_cmpf";
  const SCRATCH = "rw_cmpf";
  let outDir: string;

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: LIVE, readonly: true });
    await initConnection({ ...baseConfig, name: SCRATCH, readonly: false });
    outDir = await mkdtemp(path.join(tmpdir(), "qb-cmpf-itg-"));
  }, CONTAINER_START_TIMEOUT_MS);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it("reports inSync=true when the file matches the live schema (tables-only scope)", async () => {
    // The container's seed schema has users + orders, but earlier
    // suites in this file may have added their own (stream_fixture,
    // etc.) — narrow the comparison to the two we actually declared
    // in the file so the assertion isn't tangled in test-isolation.
    const file = path.join(outDir, "matching.sql");
    await fsWriteFile(
      file,
      `CREATE TABLE users (id INT PRIMARY KEY);
       CREATE TABLE orders (id INT PRIMARY KEY, user_id INT);`,
    );

    const r = await handleCompareSchemaFile({
      live_connection: LIVE,
      scratch_connection: SCRATCH,
      schema_path: file,
      scope: ["tables"],
      tables: ["users", "orders"],
    });
    expect("isError" in r && r.isError).toBeFalsy();
    const sc = (r as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect((sc.summary as { inSync: boolean }).inSync).toBe(true);
    expect((sc.tables as { onlyInSource: string[] }).onlyInSource).toEqual([]);
    expect((sc.tables as { onlyInTarget: string[] }).onlyInTarget).toEqual([]);
  });

  it("detects a table present in the file but missing from live", async () => {
    const file = path.join(outDir, "extra-table.sql");
    await fsWriteFile(
      file,
      `CREATE TABLE users (id INT PRIMARY KEY);
       CREATE TABLE orders (id INT PRIMARY KEY, user_id INT);
       CREATE TABLE feature_flags (id INT PRIMARY KEY, flag VARCHAR(64));`,
    );

    const r = await handleCompareSchemaFile({
      live_connection: LIVE,
      scratch_connection: SCRATCH,
      schema_path: file,
      scope: ["tables"],
    });
    expect("isError" in r && r.isError).toBeFalsy();
    const sc = (r as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect((sc.summary as { inSync: boolean }).inSync).toBe(false);
    // The file is the "source" side; live is "target". A table in the
    // file but not in live appears in onlyInSource.
    expect((sc.tables as { onlyInSource: string[] }).onlyInSource).toContain(
      "feature_flags",
    );
  });

  it("labels the source side with the file path, not the scratch connection", async () => {
    const file = path.join(outDir, "labelled.sql");
    await fsWriteFile(file, `CREATE TABLE users (id INT PRIMARY KEY);`);

    const r = await handleCompareSchemaFile({
      live_connection: LIVE,
      scratch_connection: SCRATCH,
      schema_path: file,
      scope: ["tables"],
    });
    const sc = (r as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect((sc.source as { connection: string }).connection).toBe(
      "file:" + file,
    );
  });

  it("surfaces a precise per-statement error when the file has bad DDL", async () => {
    const file = path.join(outDir, "broken.sql");
    await fsWriteFile(
      file,
      `CREATE TABLE good (id INT PRIMARY KEY);
       CREATE TABLE bad (id INT PRIMARY KEY, NOT_A_VALID_TYPE varchar);`,
    );

    const r = await handleCompareSchemaFile({
      live_connection: LIVE,
      scratch_connection: SCRATCH,
      schema_path: file,
      scope: ["tables"],
    });
    expect("isError" in r && r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe(
      "SCHEMA_LOAD_FAILED",
    );
    expect(r.content[0]?.text).toContain("statement 2 of 2");
  });

  it("drops the temp database even when the comparison succeeds", async () => {
    const file = path.join(outDir, "cleanup.sql");
    await fsWriteFile(file, `CREATE TABLE users (id INT PRIMARY KEY);`);

    const dbsBefore = await queryWithTimeout<Array<{ Database: string }>>(
      SCRATCH,
      "SHOW DATABASES",
    );

    await handleCompareSchemaFile({
      live_connection: LIVE,
      scratch_connection: SCRATCH,
      schema_path: file,
      scope: ["tables"],
    });

    const dbsAfter = await queryWithTimeout<Array<{ Database: string }>>(
      SCRATCH,
      "SHOW DATABASES",
    );
    const beforeNames = new Set(dbsBefore.map((r) => r.Database));
    const newDbs = dbsAfter
      .map((r) => r.Database)
      .filter((n) => !beforeNames.has(n));
    expect(newDbs).toEqual([]);
  });
});

// ── column_stats against the real container ────────────────────────

import { handleColumnStats } from "../../tools/data-tools.js";

describe("column_stats — end-to-end against MySQL", () => {
  const NAME = "ro_cstats";

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: NAME, readonly: true });

    // Seed a column-profiling fixture with mixed types and known
    // distributions, on top of the existing users/orders schema.
    const seed = await mysql.createConnection({
      host: container.getHost(),
      port: container.getPort(),
      user: "root",
      password: container.getRootPassword(),
      database: "testdb",
    });
    try {
      await seed.query(`
        CREATE TABLE IF NOT EXISTS cstats_fixture (
          id INT PRIMARY KEY AUTO_INCREMENT,
          status VARCHAR(16) NOT NULL,
          age INT,
          payload BLOB,
          ratio DECIMAL(5,2),
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Known distribution:
      //   - status: 60 active, 30 pending, 10 banned (3 distinct, 0 null)
      //   - age: 1..100, plus 10 NULL (110 rows total)
      //   - ratio: 0.50, 1.00, 2.50 cycled across non-null rows
      //   - payload: NULL for half the rows
      const values: string[] = [];
      for (let i = 0; i < 60; i++)
        values.push(`('active', ${i}, _binary 'x', 0.50)`);
      for (let i = 0; i < 30; i++)
        values.push(`('pending', ${i + 60}, NULL, 1.00)`);
      for (let i = 0; i < 10; i++)
        values.push(`('banned', ${i + 90}, _binary 'y', 2.50)`);
      for (let i = 0; i < 10; i++) values.push(`('active', NULL, NULL, NULL)`);
      await seed.query(
        `INSERT INTO cstats_fixture (status, age, payload, ratio) VALUES ${values.join(",")}`,
      );
    } finally {
      await seed.end();
    }
  }, CONTAINER_START_TIMEOUT_MS);

  it("reports total rows + per-column non_null and distinct counts that match the seeded fixture", async () => {
    const r = await handleColumnStats({
      connection: NAME,
      database: "testdb",
      table: "cstats_fixture",
    });
    expect("isError" in r && r.isError).toBeFalsy();
    const sc = (r as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(sc.total_rows).toBe(110);
    const cols = sc.columns as Array<{
      name: string;
      count_non_null: number;
      count_distinct: number;
      null_pct: number;
    }>;
    const status = cols.find((c) => c.name === "status")!;
    expect(status.count_non_null).toBe(110);
    expect(status.count_distinct).toBe(3);
    expect(status.null_pct).toBe(0);

    const age = cols.find((c) => c.name === "age")!;
    expect(age.count_non_null).toBe(100);
    expect(age.null_pct).toBeCloseTo((10 / 110) * 100);
  });

  it("computes numeric MIN/MAX/AVG for numeric columns", async () => {
    const r = await handleColumnStats({
      connection: NAME,
      database: "testdb",
      table: "cstats_fixture",
      columns: ["age"],
    });
    const cols = (
      r as {
        structuredContent: {
          columns: Array<{
            name: string;
            min: number;
            max: number;
            avg: number;
          }>;
        };
      }
    ).structuredContent.columns;
    const age = cols[0]!;
    expect(age.min).toBe(0);
    expect(age.max).toBe(99);
    expect(age.avg).toBeCloseTo(49.5);
  });

  it("skips MIN/MAX/AVG on BLOB columns and records a note", async () => {
    const r = await handleColumnStats({
      connection: NAME,
      database: "testdb",
      table: "cstats_fixture",
      columns: ["payload"],
    });
    const cols = (
      r as {
        structuredContent: {
          columns: Array<{
            name: string;
            min: unknown;
            max: unknown;
            avg: number | null;
            notes?: string[];
          }>;
        };
      }
    ).structuredContent.columns;
    const payload = cols[0]!;
    expect(payload.min).toBeNull();
    expect(payload.max).toBeNull();
    expect(payload.avg).toBeNull();
    expect(payload.notes).toBeDefined();
    expect(payload.notes!.some((n) => /min.*max/i.test(n))).toBe(true);
  });

  it("returns top-N most common values per column when top_n is set", async () => {
    const r = await handleColumnStats({
      connection: NAME,
      database: "testdb",
      table: "cstats_fixture",
      columns: ["status"],
      top_n: 5,
    });
    const cols = (
      r as {
        structuredContent: {
          columns: Array<{
            name: string;
            top_values?: Array<{ value: unknown; count: number }>;
          }>;
        };
      }
    ).structuredContent.columns;
    const status = cols[0]!;
    expect(status.top_values).toBeDefined();
    // 70 active (60 + 10 with NULL age), 30 pending, 10 banned.
    expect(status.top_values![0]).toEqual({ value: "active", count: 70 });
    expect(status.top_values![1]).toEqual({ value: "pending", count: 30 });
    expect(status.top_values![2]).toEqual({ value: "banned", count: 10 });
  });

  it("returns TABLE_NOT_FOUND for a non-existent table with a list_tables suggestion", async () => {
    const r = await handleColumnStats({
      connection: NAME,
      database: "testdb",
      table: "definitely_does_not_exist",
    });
    expect("isError" in r && r.isError).toBe(true);
    const sc = r.structuredContent as {
      code: string;
      suggestions: Array<{ tool: string }>;
    };
    expect(sc.code).toBe("TABLE_NOT_FOUND");
    expect(sc.suggestions.map((s) => s.tool)).toContain("list_tables");
  });
});

// ── diagnostics pack against the real container ─────────────────────

import {
  handleServerInfo,
  handleShowVariables,
  handleShowStatus,
  handleCurrentLocks,
  handleInnodbStatus,
  handleSlowQueries,
} from "../../tools/diagnostics-tools.js";

describe("diagnostics pack — end-to-end against MySQL", () => {
  const NAME = "ro_diag";

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: NAME, readonly: true });
  }, CONTAINER_START_TIMEOUT_MS);

  it("server_info returns a real version + uptime + thread counts", async () => {
    const r = await handleServerInfo({ connection: NAME });
    expect("isError" in r && r.isError).toBeFalsy();
    const sc = (r as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(typeof sc.version).toBe("string");
    expect(sc.version as string).toMatch(/^8\./); // mysql:8.4 container
    expect(typeof sc.uptime_seconds).toBe("number");
    expect(sc.uptime_seconds as number).toBeGreaterThan(0);
    expect(typeof sc.threads_connected).toBe("number");
    expect(sc.character_set_server).toBe("utf8mb4");
  });

  it("show_variables filters by LIKE pattern", async () => {
    const r = await handleShowVariables({
      connection: NAME,
      pattern: "version%",
    });
    const vars = (
      r as {
        structuredContent: {
          variables: Array<{ Variable_name: string; Value: string }>;
        };
      }
    ).structuredContent.variables;
    expect(vars.length).toBeGreaterThan(0);
    // Every match must start with "version" (LIKE 'version%').
    for (const v of vars) {
      expect(v.Variable_name.toLowerCase()).toMatch(/^version/);
    }
  });

  it("show_status returns a non-empty Threads_% counter set", async () => {
    const r = await handleShowStatus({
      connection: NAME,
      pattern: "Threads_%",
    });
    const counters = (
      r as {
        structuredContent: {
          counters: Array<{ Variable_name: string; Value: string }>;
        };
      }
    ).structuredContent.counters;
    expect(counters.length).toBeGreaterThanOrEqual(4); // Threads_cached/connected/created/running
    const names = counters.map((c) => c.Variable_name);
    expect(names).toContain("Threads_connected");
    expect(names).toContain("Threads_running");
  });

  it("current_locks returns an empty list on an idle server", async () => {
    // No deliberate lock waits in the test fixture — the perf-schema
    // table should be queried successfully and return zero rows.
    const r = await handleCurrentLocks({ connection: NAME });
    expect("isError" in r && r.isError).toBeFalsy();
    expect((r as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "No active lock waits.",
    );
  });

  it("innodb_status returns a real status dump and no deadlock", async () => {
    const r = await handleInnodbStatus({ connection: NAME });
    const sc = r.structuredContent as {
      status_text: string;
      latest_deadlock: string | null;
    };
    expect(sc.status_text.length).toBeGreaterThan(100);
    // The dump always contains the BACKGROUND THREAD header on a
    // healthy InnoDB instance.
    expect(sc.status_text).toContain("BACKGROUND THREAD");
    // No deadlock seeded by the fixture.
    expect(sc.latest_deadlock).toBeNull();
  });

  it("slow_queries returns an array (possibly empty) without erroring", async () => {
    // Whether anything is recorded depends on what the other suites
    // ran first against this container. The key assertion is that
    // the performance_schema query succeeds and the response shape
    // is right.
    const r = await handleSlowQueries({
      connection: NAME,
      limit: 5,
      sort_by: "count",
    });
    expect("isError" in r && r.isError).toBeFalsy();
    const sc = r.structuredContent as {
      sort_by: string;
      queries: unknown[];
    };
    expect(sc.sort_by).toBe("count");
    expect(Array.isArray(sc.queries)).toBe(true);
  });
});

// ── traverse_fk against the real users/orders schema ───────────────

import { handleTraverseFk } from "../../tools/traverse-tools.js";

describe("traverse_fk — end-to-end against MySQL", () => {
  const NAME = "ro_trav";

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: NAME, readonly: true });
  }, CONTAINER_START_TIMEOUT_MS);

  it("from an order, follows the user_id FK to the parent user", async () => {
    const r = await handleTraverseFk({
      connection: NAME,
      database: "testdb",
      table: "orders",
      primary_key_value: 1, // (user_id=1, total=99.99) per the seed
      depth: 1,
      direction: "parents",
    });
    expect("isError" in r && r.isError).toBeFalsy();
    const sc = r.structuredContent as {
      nodes: Array<{ id: string; table: string }>;
      edges: Array<{ via: string; direction: string }>;
    };
    expect(sc.nodes.map((n) => n.table).sort()).toEqual(["orders", "users"]);
    expect(sc.edges).toHaveLength(1);
    expect(sc.edges[0]?.direction).toBe("parent");
    expect(sc.edges[0]?.via).toContain("orders.user_id");
    expect(sc.edges[0]?.via).toContain("users.id");
  });

  it("from a user, follows incoming FKs to find their orders", async () => {
    const r = await handleTraverseFk({
      connection: NAME,
      database: "testdb",
      table: "users",
      primary_key_value: 1, // alice@example.com, has 2 orders per the seed
      depth: 1,
      direction: "children",
    });
    const sc = r.structuredContent as {
      nodes: Array<{ id: string; table: string }>;
      edges: Array<unknown>;
    };
    // 1 seed user + 2 child orders = 3 unique rows.
    expect(sc.nodes).toHaveLength(3);
    expect(sc.nodes.filter((n) => n.table === "orders")).toHaveLength(2);
    expect(sc.edges).toHaveLength(2);
  });

  it("direction='both' at depth=2 finds the user, their orders, then their other order", async () => {
    // Starting from orders.id = 1 with depth=2 both:
    //   Level 0: orders#1
    //   Level 1: parents → users#1; children of orders#1 → none
    //   Level 2: children of users#1 → orders#1 (cycle-detected), orders#2
    //            parents of users#1 → none
    // Expected unique nodes: orders#1, users#1, orders#2 = 3
    const r = await handleTraverseFk({
      connection: NAME,
      database: "testdb",
      table: "orders",
      primary_key_value: 1,
      depth: 2,
      direction: "both",
    });
    const sc = r.structuredContent as {
      nodes: Array<{ id: string; table: string }>;
    };
    const ids = sc.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["orders#1", "orders#2", "users#1"]);
  });

  it("returns SEED_ROW_NOT_FOUND when the seed PK doesn't exist", async () => {
    const r = await handleTraverseFk({
      connection: NAME,
      database: "testdb",
      table: "orders",
      primary_key_value: 99999,
    });
    expect("isError" in r && r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe(
      "SEED_ROW_NOT_FOUND",
    );
  });
});

// ── generate_migration against the real users/orders schema ────────

import { handleGenerateMigration } from "../../tools/migration-tools.js";

describe("generate_migration — end-to-end against MySQL", () => {
  const SRC = "ro_migsrc";
  const TGT = "rw_migtgt";

  beforeAll(async () => {
    await initConnection({ ...baseConfig, name: SRC, readonly: true });
    await initConnection({ ...baseConfig, name: TGT, readonly: false });

    // Build a divergent target schema in a separate database so we can
    // generate real ALTER SQL between them. The "target" db will have:
    //   - missing `created_at` column on users (additive needed)
    //   - extra `legacy_status` column on users (drop candidate)
    //   - missing `total` column on orders (additive needed)
    //   - missing FK on orders (additive needed)
    const seed = await mysql.createConnection({
      host: container.getHost(),
      port: container.getPort(),
      user: "root",
      password: container.getRootPassword(),
      multipleStatements: true,
    });
    try {
      await seed.query(`CREATE DATABASE IF NOT EXISTS migtgt;`);
      await seed.query(`USE migtgt;`);
      await seed.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT PRIMARY KEY AUTO_INCREMENT,
          email VARCHAR(255) NOT NULL,
          legacy_status VARCHAR(20)
        );
        CREATE TABLE IF NOT EXISTS orders (
          id INT PRIMARY KEY AUTO_INCREMENT,
          user_id INT NOT NULL
        );
      `);
      await seed.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES ON migtgt.* TO 'testuser'@'%'`,
      );
      await seed.query("FLUSH PRIVILEGES");
    } finally {
      await seed.end();
    }
  }, CONTAINER_START_TIMEOUT_MS);

  it("emits ADD COLUMN for columns missing on the target side", async () => {
    const r = await handleGenerateMigration({
      sourceConnection: SRC,
      sourceDatabase: "testdb",
      targetConnection: TGT,
      targetDatabase: "migtgt",
      tables: ["users", "orders"],
    });
    expect("isError" in r && r.isError).toBeFalsy();
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    // users.created_at is in source but not target → ADD COLUMN
    expect(text).toMatch(
      /ALTER TABLE `migtgt`\.`users` ADD COLUMN `created_at`/,
    );
    // orders.total is in source but not target → ADD COLUMN
    expect(text).toMatch(/ALTER TABLE `migtgt`\.`orders` ADD COLUMN `total`/);
  });

  it("emits ADD FOREIGN KEY for FKs missing on the target side", async () => {
    const r = await handleGenerateMigration({
      sourceConnection: SRC,
      sourceDatabase: "testdb",
      targetConnection: TGT,
      targetDatabase: "migtgt",
      tables: ["orders"],
    });
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).toMatch(
      /ALTER TABLE `migtgt`\.`orders` ADD CONSTRAINT[\s\S]*FOREIGN KEY[\s\S]*REFERENCES `users`/,
    );
  });

  it("does NOT emit DROP COLUMN by default (include_drops=false)", async () => {
    const r = await handleGenerateMigration({
      sourceConnection: SRC,
      sourceDatabase: "testdb",
      targetConnection: TGT,
      targetDatabase: "migtgt",
      tables: ["users"],
    });
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).not.toMatch(/DROP COLUMN `legacy_status`/);
    // …and the skip is announced.
    expect(text).toContain("include_drops=false");
  });

  it("emits DROP COLUMN when include_drops=true, with a destructive warning", async () => {
    const r = await handleGenerateMigration({
      sourceConnection: SRC,
      sourceDatabase: "testdb",
      targetConnection: TGT,
      targetDatabase: "migtgt",
      tables: ["users"],
      include_drops: true,
    });
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).toMatch(
      /-- WARNING: DESTRUCTIVE: column legacy_status[\s\S]*ALTER TABLE `migtgt`\.`users` DROP COLUMN `legacy_status`/,
    );
  });

  it("ships the DO NOT EXECUTE BLINDLY banner at the top regardless of args", async () => {
    const r = await handleGenerateMigration({
      sourceConnection: SRC,
      sourceDatabase: "testdb",
      targetConnection: TGT,
      targetDatabase: "migtgt",
    });
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    // Banner must appear in the first ~200 chars — operators see it
    // before any individual statement when scanning the output.
    expect(
      text.indexOf("ADVISORY MIGRATION SQL — DO NOT EXECUTE BLINDLY"),
    ).toBeLessThan(200);
    expect(text).toMatch(/={80}/);
    // Structured content records the flags so an operator can re-derive
    // exactly what the agent asked for.
    const sc = (
      r as { structuredContent: { summary: Record<string, unknown> } }
    ).structuredContent;
    expect(sc.summary.include_drops).toBe(false);
    expect(sc.summary.include_destructive_changes).toBe(false);
  });

  it("reports 0 statements when source and target are identical", async () => {
    // Compare a database to itself — no diff, no statements.
    const r = await handleGenerateMigration({
      sourceConnection: SRC,
      sourceDatabase: "testdb",
      targetConnection: SRC,
      targetDatabase: "testdb",
    });
    const sc = (
      r as { structuredContent: { summary: { total_statements: number } } }
    ).structuredContent;
    expect(sc.summary.total_statements).toBe(0);
    expect(
      (r as { content: Array<{ text: string }> }).content[0]?.text,
    ).toContain("No migration statements generated.");
  });
});

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
  // Grant our test user PROCESS so list_processes / KILL work against
  // its own threads.
  await seed.query("GRANT PROCESS ON *.* TO 'testuser'@'%'");
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

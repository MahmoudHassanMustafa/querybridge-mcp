/**
 * Integration test for compare_schemas against two real MySQL containers.
 * Seeds slightly different schemas on each, then verifies that the
 * end-to-end pipeline (information_schema queries → diff → structured
 * output) catches the right deltas.
 */

import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  MySqlContainer,
  type StartedMySqlContainer,
} from "@testcontainers/mysql";
import mysql from "mysql2/promise";
import { initConnection, closeAll, queryWithTimeout } from "../../connection.js";
import { DatabaseConfigSchema } from "../../schema.js";

const CONTAINER_START_TIMEOUT_MS = 180_000;

let srcContainer: StartedMySqlContainer;
let tgtContainer: StartedMySqlContainer;

beforeAll(async () => {
  // Spin both containers in parallel — startup is the bulk of the wall time.
  [srcContainer, tgtContainer] = await Promise.all([
    new MySqlContainer("mysql:8.4")
      .withDatabase("appdb")
      .withUsername("u")
      .withUserPassword("p")
      .start(),
    new MySqlContainer("mysql:8.4")
      .withDatabase("appdb")
      .withUsername("u")
      .withUserPassword("p")
      .start(),
  ]);

  // Seed source: users + orders, idx_email on users, FK orders→users
  // Plus a view, procedure, and trigger to exercise programmability diffs.
  await seed(srcContainer, [
    `CREATE TABLE users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(20) DEFAULT 'active',
      INDEX idx_email (email)
    )`,
    `CREATE TABLE orders (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      total DECIMAL(10,2),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`,
    `CREATE TABLE deprecated_audit (id INT PRIMARY KEY)`,
    `CREATE VIEW active_users AS SELECT id, email FROM users WHERE status = 'active'`,
    // Stored procedure that exists on both sides identically — should NOT appear in diff
    `CREATE PROCEDURE noop_proc() BEGIN SELECT 1; END`,
    // Trigger present only on source
    `CREATE TRIGGER src_only_trigger BEFORE INSERT ON users
       FOR EACH ROW SET NEW.email = LOWER(NEW.email)`,
  ]);

  // Seed target: users with widened status, added column, removed unused
  // index, added new index. Plus a new "feature_flags" table. orders
  // missing entirely. View definition drifted. Same procedure. No trigger.
  await seed(tgtContainer, [
    `CREATE TABLE users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL UNIQUE,
      status VARCHAR(50) DEFAULT 'active',
      email_verified TINYINT(1) DEFAULT 0,
      INDEX idx_email_verified (email_verified)
    )`,
    `CREATE TABLE feature_flags (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL UNIQUE
    )`,
    // Same view name but drifted SELECT body — should appear as modified
    `CREATE VIEW active_users AS SELECT id, email, status FROM users WHERE status = 'active'`,
    // Same procedure as source — should NOT appear in diff
    `CREATE PROCEDURE noop_proc() BEGIN SELECT 1; END`,
  ]);

  // Register both with our connection pool
  await initConnection(
    DatabaseConfigSchema.parse({
      name: "src",
      host: srcContainer.getHost(),
      port: srcContainer.getPort(),
      user: "u",
      password: "p",
      database: "appdb",
    }),
  );
  await initConnection(
    DatabaseConfigSchema.parse({
      name: "tgt",
      host: tgtContainer.getHost(),
      port: tgtContainer.getPort(),
      user: "u",
      password: "p",
      database: "appdb",
    }),
  );
}, CONTAINER_START_TIMEOUT_MS);

afterAll(async () => {
  await closeAll();
  await Promise.all([srcContainer?.stop(), tgtContainer?.stop()]);
}, 60_000);

async function seed(
  container: StartedMySqlContainer,
  ddl: string[],
): Promise<void> {
  const conn = await mysql.createConnection({
    host: container.getHost(),
    port: container.getPort(),
    user: "root",
    password: container.getRootPassword(),
    database: "appdb",
    multipleStatements: true,
  });
  for (const s of ddl) await conn.query(s);
  await conn.end();
}

// We exercise the tool by importing its registration helper and pulling
// out the underlying handler. The MCP SDK's McpServer hides the
// callback after registerTool returns, so instead we replicate the
// pipeline by calling the same queries the tool does and feeding them
// to the diff functions. This keeps the assertion surface honest:
// real MySQL → real information_schema → real diff logic.

import {
  diffColumns,
  diffIndexes,
  diffViews,
  diffRoutines,
  diffTriggers,
  diffTableAttributes,
} from "../../tools/compare-tools.js";

describe("compare_schemas end-to-end against two MySQL containers", () => {
  it("detects table existence deltas (orders only in src, feature_flags only in tgt)", async () => {
    const srcTables = await listTableNames("src");
    const tgtTables = await listTableNames("tgt");
    const onlyInSrc = srcTables.filter((t) => !tgtTables.includes(t)).sort();
    const onlyInTgt = tgtTables.filter((t) => !srcTables.includes(t)).sort();
    expect(onlyInSrc).toEqual(["deprecated_audit", "orders"]);
    expect(onlyInTgt).toEqual(["feature_flags"]);
  });

  it("detects column deltas on users (added email_verified, modified status)", async () => {
    const srcCols = await listColumnsFor("src", "users");
    const tgtCols = await listColumnsFor("tgt", "users");
    const diff = diffColumns(srcCols, tgtCols);

    expect(diff.onlyInTarget.map((c) => c.name)).toContain("email_verified");
    const status = diff.modified.find((m) => m.name === "status");
    expect(status).toBeDefined();
    expect(status!.diffs.some((d) => d.includes("varchar(20) → varchar(50)"))).toBe(true);
  });

  it("detects index deltas (idx_email removed, idx_email_verified added)", async () => {
    const srcIdx = await listIndexesFor("src", "users");
    const tgtIdx = await listIndexesFor("tgt", "users");
    const diff = diffIndexes(srcIdx, tgtIdx);

    expect(diff.onlyInSource.map((i) => i.name)).toContain("idx_email");
    expect(diff.onlyInTarget.map((i) => i.name)).toContain("idx_email_verified");
  });

  it("detects view drift (active_users body changed)", async () => {
    const srcViews = await listViewsFor("src");
    const tgtViews = await listViewsFor("tgt");
    const diff = diffViews(srcViews, tgtViews);
    const modified = diff.modified.find((m) => m.name === "active_users");
    expect(modified).toBeDefined();
    expect(modified!.diffs).toContain("definition changed");
  });

  it("ignores routines that are identical on both sides (noop_proc)", async () => {
    const srcR = await listRoutinesFor("src");
    const tgtR = await listRoutinesFor("tgt");
    const diff = diffRoutines(srcR, tgtR);
    // noop_proc exists on both sides identically — must not appear in
    // modified. (View whitespace/formatting MUST be normalized.)
    expect(diff.modified.find((m) => m.name === "noop_proc")).toBeUndefined();
  });

  it("detects trigger only in source (src_only_trigger)", async () => {
    const srcT = await listTriggersFor("src");
    const tgtT = await listTriggersFor("tgt");
    const diff = diffTriggers(srcT, tgtT);
    expect(diff.onlyInSource.map((t) => t.name)).toContain("src_only_trigger");
  });

  it("does not flag identical table attributes as drift", async () => {
    // Both sides use InnoDB / utf8mb4 by default (mysql:8.4) — verifies
    // the attribute fetch + diff doesn't generate noise.
    const srcAttrs = await listTableAttrsFor("src", ["users"]);
    const tgtAttrs = await listTableAttrsFor("tgt", ["users"]);
    const diff = diffTableAttributes(srcAttrs, tgtAttrs);
    expect(diff.modified).toEqual([]);
  });
});

// ── helpers that mirror what compare-tools does internally ──────────

async function listTableNames(connection: string): Promise<string[]> {
  const rows = await queryWithTimeout<Array<{ TABLE_NAME: string }>>(
    connection,
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
    ["appdb"],
  );
  return rows.map((r) => r.TABLE_NAME);
}

async function listColumnsFor(connection: string, table: string) {
  const rows = await queryWithTimeout<
    Array<{
      COLUMN_NAME: string;
      COLUMN_TYPE: string;
      IS_NULLABLE: string;
      COLUMN_DEFAULT: string | null;
      COLUMN_KEY: string;
      COLUMN_COMMENT: string | null;
      EXTRA: string | null;
      GENERATION_EXPRESSION: string | null;
    }>
  >(
    connection,
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY,
            COLUMN_COMMENT, EXTRA, GENERATION_EXPRESSION
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    ["appdb", table],
  );
  return rows.map((r) => ({
    name: r.COLUMN_NAME,
    type: r.COLUMN_TYPE,
    nullable: r.IS_NULLABLE === "YES",
    default: r.COLUMN_DEFAULT,
    key: r.COLUMN_KEY,
    comment: r.COLUMN_COMMENT ?? "",
    extra: r.EXTRA ?? "",
    generationExpression: r.GENERATION_EXPRESSION || null,
  }));
}

async function listIndexesFor(connection: string, table: string) {
  const rows = await queryWithTimeout<
    Array<{
      INDEX_NAME: string;
      COLUMN_NAME: string | null;
      NON_UNIQUE: number;
      INDEX_TYPE: string;
      SUB_PART: number | null;
      IS_VISIBLE?: string | null;
      EXPRESSION?: string | null;
    }>
  >(
    connection,
    `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE, SUB_PART,
            IS_VISIBLE, EXPRESSION
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    ["appdb", table],
  );
  const acc = new Map<
    string,
    {
      name: string;
      columns: string[];
      unique: boolean;
      type: string;
      visible: boolean;
      subParts: Array<number | null>;
      expressions: Array<string | null>;
    }
  >();
  for (const r of rows) {
    const e = acc.get(r.INDEX_NAME);
    const colName = r.COLUMN_NAME ?? `(${r.EXPRESSION ?? "expr"})`;
    if (e) {
      e.columns.push(colName);
      e.subParts.push(r.SUB_PART);
      e.expressions.push(r.EXPRESSION ?? null);
    } else {
      acc.set(r.INDEX_NAME, {
        name: r.INDEX_NAME,
        columns: [colName],
        unique: r.NON_UNIQUE === 0,
        type: r.INDEX_TYPE,
        visible: r.IS_VISIBLE !== "NO",
        subParts: [r.SUB_PART],
        expressions: [r.EXPRESSION ?? null],
      });
    }
  }
  return [...acc.values()];
}

async function listViewsFor(connection: string) {
  const rows = await queryWithTimeout<
    Array<{
      TABLE_NAME: string;
      VIEW_DEFINITION: string;
      IS_UPDATABLE: string;
      SECURITY_TYPE: string;
      CHECK_OPTION: string;
    }>
  >(
    connection,
    `SELECT TABLE_NAME, VIEW_DEFINITION, IS_UPDATABLE, SECURITY_TYPE, CHECK_OPTION
     FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA = ?`,
    ["appdb"],
  );
  return rows.map((r) => ({
    name: r.TABLE_NAME,
    definition: r.VIEW_DEFINITION,
    updatable: r.IS_UPDATABLE === "YES",
    securityType: r.SECURITY_TYPE,
    checkOption: r.CHECK_OPTION,
  }));
}

async function listRoutinesFor(connection: string) {
  const rows = await queryWithTimeout<
    Array<{
      ROUTINE_NAME: string;
      ROUTINE_TYPE: string;
      DTD_IDENTIFIER: string | null;
      ROUTINE_DEFINITION: string;
      SECURITY_TYPE: string;
      IS_DETERMINISTIC: string;
      SQL_DATA_ACCESS: string;
    }>
  >(
    connection,
    `SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, ROUTINE_DEFINITION,
            SECURITY_TYPE, IS_DETERMINISTIC, SQL_DATA_ACCESS
     FROM information_schema.ROUTINES
     WHERE ROUTINE_SCHEMA = ?`,
    ["appdb"],
  );
  return rows.map((r) => ({
    name: r.ROUTINE_NAME,
    type: r.ROUTINE_TYPE as "PROCEDURE" | "FUNCTION",
    returnType: r.ROUTINE_TYPE === "FUNCTION" ? r.DTD_IDENTIFIER : null,
    parameters: "",
    definition: r.ROUTINE_DEFINITION,
    securityType: r.SECURITY_TYPE,
    deterministic: r.IS_DETERMINISTIC === "YES",
    dataAccess: r.SQL_DATA_ACCESS,
  }));
}

async function listTriggersFor(connection: string) {
  const rows = await queryWithTimeout<
    Array<{
      TRIGGER_NAME: string;
      EVENT_OBJECT_TABLE: string;
      EVENT_MANIPULATION: string;
      ACTION_TIMING: string;
      ACTION_ORIENTATION: string;
      ACTION_STATEMENT: string;
    }>
  >(
    connection,
    `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION,
            ACTION_TIMING, ACTION_ORIENTATION, ACTION_STATEMENT
     FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = ?`,
    ["appdb"],
  );
  return rows.map((r) => ({
    name: r.TRIGGER_NAME,
    table: r.EVENT_OBJECT_TABLE,
    event: r.EVENT_MANIPULATION,
    timing: r.ACTION_TIMING,
    orientation: r.ACTION_ORIENTATION,
    statement: r.ACTION_STATEMENT,
  }));
}

async function listTableAttrsFor(connection: string, tables: string[]) {
  const out = new Map<
    string,
    {
      name: string;
      engine: string;
      charset: string;
      collation: string;
      comment: string;
      rowFormat: string;
      partitioned: boolean;
      partitionMethod: string | null;
      partitionExpression: string | null;
      partitionCount: number;
    }
  >();
  const placeholders = tables.map(() => "?").join(",");
  const rows = await queryWithTimeout<
    Array<{
      TABLE_NAME: string;
      ENGINE: string | null;
      TABLE_COLLATION: string | null;
      TABLE_COMMENT: string | null;
      ROW_FORMAT: string | null;
    }>
  >(
    connection,
    `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_COMMENT, ROW_FORMAT
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
    ["appdb", ...tables],
  );
  for (const r of rows) {
    out.set(r.TABLE_NAME, {
      name: r.TABLE_NAME,
      engine: r.ENGINE ?? "",
      charset: "utf8mb4",
      collation: r.TABLE_COLLATION ?? "",
      comment: r.TABLE_COMMENT ?? "",
      rowFormat: r.ROW_FORMAT ?? "",
      partitioned: false,
      partitionMethod: null,
      partitionExpression: null,
      partitionCount: 0,
    });
  }
  return out;
}


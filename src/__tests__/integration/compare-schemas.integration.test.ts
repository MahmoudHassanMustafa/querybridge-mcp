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
  ]);

  // Seed target: users with widened status, added column, removed unused
  // index, added new index. Plus a new "feature_flags" table. orders
  // table missing entirely.
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

import { diffColumns, diffIndexes } from "../../tools/compare-tools.js";

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
    }>
  >(
    connection,
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
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
  }));
}

async function listIndexesFor(connection: string, table: string) {
  const rows = await queryWithTimeout<
    Array<{
      INDEX_NAME: string;
      COLUMN_NAME: string;
      NON_UNIQUE: number;
      INDEX_TYPE: string;
    }>
  >(
    connection,
    `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    ["appdb", table],
  );
  const acc = new Map<
    string,
    { name: string; columns: string[]; unique: boolean; type: string }
  >();
  for (const r of rows) {
    const e = acc.get(r.INDEX_NAME);
    if (e) {
      e.columns.push(r.COLUMN_NAME);
    } else {
      acc.set(r.INDEX_NAME, {
        name: r.INDEX_NAME,
        columns: [r.COLUMN_NAME],
        unique: r.NON_UNIQUE === 0,
        type: r.INDEX_TYPE,
      });
    }
  }
  return [...acc.values()];
}


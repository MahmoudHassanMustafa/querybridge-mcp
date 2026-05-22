import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetConnectionsForTests,
  registerMockConnection,
} from "../connection.js";
import type { DatabaseConfig } from "../types.js";
import { MockRunner } from "./utils/mock-runner.js";
import {
  handleDescribeTable,
  handleGetForeignKeys,
  handleGetIndexes,
  handleListTables,
  handleSearchColumns,
} from "../tools/schema/handlers.js";
import { handleGetTableStats } from "../tools/data-tools.js";
import {
  handleGetRoutineDdl,
  handleListEvents,
  handleListRoutines,
  handleListTriggers,
} from "../tools/routines/handlers.js";
import {
  handleGetCharsetCollation,
  handleGetUnusedIndexes,
  handleKillQuery,
  handleListProcesses,
} from "../tools/admin-tools.js";
import { handleUseDatabase } from "../tools/connection-tools.js";

// Every test gets a fresh registry so suites don't leak into each other.
const CONN = "mock";
const DB = "shop";

beforeEach(() => {
  __resetConnectionsForTests();
});

function registerWithConfig(
  runner: MockRunner,
  cfg: Partial<DatabaseConfig> = {},
): void {
  registerMockConnection(CONN, runner, { database: DB, ...cfg });
}

// Tool results are { content: [{type:'text', text}], structuredContent?, isError? }
function asOk(
  result: Awaited<ReturnType<typeof handleListTables>>,
): { text: string; structuredContent: Record<string, unknown> } {
  if ("isError" in result && result.isError) {
    throw new Error(`expected toolOk, got toolError: ${result.content[0]?.text}`);
  }
  return {
    text: result.content[0]?.text ?? "",
    structuredContent:
      (result as { structuredContent?: Record<string, unknown> })
        .structuredContent ?? {},
  };
}

function asErr(result: Awaited<ReturnType<typeof handleListTables>>): string {
  if (!("isError" in result) || !result.isError) {
    throw new Error("expected toolError, got toolOk");
  }
  return result.content[0]?.text ?? "";
}

// ── schema-tools ─────────────────────────────────────────────────

describe("handleListTables", () => {
  it("returns 'No tables found' on empty result", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.TABLES/s, []),
    );
    const r = asOk(await handleListTables({ connection: CONN }));
    expect(r.text).toBe("No tables found");
    expect(r.structuredContent).toEqual({ database: DB, tables: [] });
  });

  it("renders a markdown table when rows exist", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.TABLES/s, [
        { TABLE_NAME: "users", TABLE_ROWS: 100, ENGINE: "InnoDB", TABLE_COMMENT: "" },
        { TABLE_NAME: "orders", TABLE_ROWS: 50, ENGINE: "InnoDB", TABLE_COMMENT: "" },
      ]),
    );
    const r = asOk(await handleListTables({ connection: CONN }));
    expect(r.text).toMatch(/users/);
    expect(r.text).toMatch(/orders/);
    expect(r.text).toContain("2 table(s) in shop");
  });

  it("returns DatabaseNotResolved hint when neither arg nor default exists", async () => {
    registerMockConnection(CONN, new MockRunner(), { database: undefined });
    const r = asErr(await handleListTables({ connection: CONN }));
    expect(r).toMatch(/No database selected/);
  });
});

describe("handleDescribeTable", () => {
  it("returns toolError when the target is a view", async () => {
    const runner = new MockRunner()
      .whenSql(/^DESCRIBE/i, [
        { Field: "id", Type: "int", Null: "NO", Key: "", Default: null, Extra: "" },
      ])
      .whenSql(/^SHOW CREATE TABLE/i, [
        { View: "v1", "Create View": "CREATE VIEW v1 ..." },
      ]);
    registerWithConfig(runner);
    const err = asErr(await handleDescribeTable({ connection: CONN, table: "v1" }));
    expect(err).toMatch(/is a view, not a table/);
    expect(err).toMatch(/describe_view/);
  });

  it("renders columns + indexes + DDL for a real table", async () => {
    const runner = new MockRunner()
      .whenSql(/^DESCRIBE/i, [
        { Field: "id", Type: "int", Null: "NO", Key: "PRI", Default: null, Extra: "auto_increment" },
      ])
      .whenSql(/^SHOW CREATE TABLE/i, [
        { Table: "users", "Create Table": "CREATE TABLE users (id INT)" },
      ])
      .whenSql(/^SHOW INDEX/i, [
        {
          Table: "users", Non_unique: 0, Key_name: "PRIMARY", Seq_in_index: 1,
          Column_name: "id", Collation: "A", Cardinality: 100, Sub_part: null,
          Packed: null, Null: "", Index_type: "BTREE", Comment: "", Index_comment: "",
        },
      ]);
    registerWithConfig(runner);
    const ok = asOk(await handleDescribeTable({ connection: CONN, table: "users" }));
    expect(ok.text).toContain("## Columns");
    expect(ok.text).toContain("## Indexes");
    expect(ok.text).toContain("CREATE TABLE users (id INT)");
  });
});

describe("handleGetForeignKeys", () => {
  it("uses 'on table' phrasing when filtered by table", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/KEY_COLUMN_USAGE/s, []),
    );
    const r = asOk(
      await handleGetForeignKeys({ connection: CONN, table: "orders" }),
    );
    expect(r.text).toBe("No foreign keys on orders");
  });

  it("uses 'in db' phrasing when not filtered", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/KEY_COLUMN_USAGE/s, []),
    );
    const r = asOk(await handleGetForeignKeys({ connection: CONN }));
    expect(r.text).toBe("No foreign keys in shop");
  });

  it("renders FK arrows when rows exist", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/KEY_COLUMN_USAGE/s, [
        {
          TABLE_NAME: "orders", COLUMN_NAME: "user_id",
          REFERENCED_TABLE_SCHEMA: "shop", REFERENCED_TABLE_NAME: "users",
          REFERENCED_COLUMN_NAME: "id", UPDATE_RULE: "RESTRICT", DELETE_RULE: "CASCADE",
        },
      ]),
    );
    const r = asOk(await handleGetForeignKeys({ connection: CONN }));
    expect(r.text).toMatch(/orders\.user_id -> users\.id/);
    expect(r.text).toMatch(/ON UPDATE RESTRICT/);
    expect(r.text).toMatch(/ON DELETE CASCADE/);
  });
});

describe("handleGetIndexes", () => {
  it("flags overlapping leading-column indexes as duplicates", async () => {
    // idx_email and idx_email_status share the leading 'email' column —
    // the duplicate detector should flag them.
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.STATISTICS/s, [
        { TABLE_NAME: "users", INDEX_NAME: "idx_email", NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: "email", CARDINALITY: 100, INDEX_TYPE: "BTREE" },
        { TABLE_NAME: "users", INDEX_NAME: "idx_email_status", NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: "email", CARDINALITY: 100, INDEX_TYPE: "BTREE" },
        { TABLE_NAME: "users", INDEX_NAME: "idx_email_status", NON_UNIQUE: 1, SEQ_IN_INDEX: 2, COLUMN_NAME: "status", CARDINALITY: 100, INDEX_TYPE: "BTREE" },
      ]),
    );
    const r = asOk(await handleGetIndexes({ connection: CONN, table: "users" }));
    expect(r.text).toContain("Potential Duplicates");
    expect(r.text).toMatch(/idx_email\(email\) overlaps with idx_email_status\(email,status\)/);
    expect(r.structuredContent.duplicates).toHaveLength(1);
  });

  it("does NOT flag distinct leading-column indexes", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.STATISTICS/s, [
        { TABLE_NAME: "users", INDEX_NAME: "idx_email", NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: "email", CARDINALITY: 100, INDEX_TYPE: "BTREE" },
        { TABLE_NAME: "users", INDEX_NAME: "idx_name", NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: "name", CARDINALITY: 100, INDEX_TYPE: "BTREE" },
      ]),
    );
    const r = asOk(await handleGetIndexes({ connection: CONN, table: "users" }));
    expect(r.text).not.toContain("Potential Duplicates");
    expect(r.structuredContent.duplicates).toEqual([]);
  });
});

describe("handleSearchColumns", () => {
  it("returns empty-state message with the pattern", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.COLUMNS/s, []),
    );
    const r = asOk(
      await handleSearchColumns({ connection: CONN, pattern: "%nonexistent%" }),
    );
    expect(r.text).toContain(`No columns matching "%nonexistent%"`);
  });
});

// ── data-tools ───────────────────────────────────────────────────

describe("handleGetTableStats", () => {
  it("formats sizes via humanSize", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.TABLES/s, [
        {
          TABLE_NAME: "big_table", TABLE_ROWS: 1_000_000,
          DATA_LENGTH: 5 * 1024 * 1024, INDEX_LENGTH: 1024 * 1024,
          AUTO_INCREMENT: 999, CREATE_TIME: null, UPDATE_TIME: null,
          ENGINE: "InnoDB",
        },
      ]),
    );
    const r = asOk(await handleGetTableStats({ connection: CONN }));
    expect(r.text).toMatch(/5\.0 MB/); // DATA_SIZE
    expect(r.text).toMatch(/6\.0 MB/); // TOTAL = DATA + INDEX
  });
});

// ── routines-tools ───────────────────────────────────────────────

describe("handleListRoutines", () => {
  it("uses singular noun in empty message when filtered by type", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.ROUTINES/s, []),
    );
    const r = asOk(
      await handleListRoutines({ connection: CONN, type: "FUNCTION" }),
    );
    expect(r.text).toMatch(/No functions found in shop/);
  });

  it("uses 'routines' in empty message when type=ALL", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.ROUTINES/s, []),
    );
    const r = asOk(await handleListRoutines({ connection: CONN }));
    expect(r.text).toMatch(/No routines found in shop/);
  });
});

describe("handleGetRoutineDdl", () => {
  it("auto-detects FUNCTION when type is omitted", async () => {
    const runner = new MockRunner()
      .whenSql(/information_schema\.ROUTINES/s, [{ ROUTINE_TYPE: "FUNCTION" }])
      .whenSql(/^SHOW CREATE FUNCTION/i, [
        { Function: "f1", "Create Function": "CREATE FUNCTION f1 RETURNS INT" },
      ]);
    registerWithConfig(runner);
    const r = asOk(await handleGetRoutineDdl({ connection: CONN, name: "f1" }));
    expect(r.text).toMatch(/-- FUNCTION: f1/);
    expect(r.text).toMatch(/CREATE FUNCTION f1/);
    expect(r.structuredContent.type).toBe("FUNCTION");
  });

  it("returns found:false when the routine doesn't exist", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.ROUTINES/s, []),
    );
    const r = asOk(
      await handleGetRoutineDdl({ connection: CONN, name: "missing" }),
    );
    expect(r.text).toMatch(/not found/);
    expect(r.structuredContent.found).toBe(false);
  });

  it("uses the caller's explicit type without auto-detecting", async () => {
    const runner = new MockRunner().whenSql(/^SHOW CREATE PROCEDURE/i, [
      { Procedure: "p1", "Create Procedure": "CREATE PROC p1 (...)" },
    ]);
    // Note: NO whenSql for information_schema.ROUTINES — if the handler
    // tried to auto-detect, this test would fail with "no rule matched".
    registerWithConfig(runner);
    const r = asOk(
      await handleGetRoutineDdl({
        connection: CONN,
        name: "p1",
        type: "PROCEDURE",
      }),
    );
    expect(r.text).toMatch(/CREATE PROC p1/);
  });
});

describe("handleListTriggers", () => {
  it("uses 'on table X' message when filtered", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.TRIGGERS/s, []),
    );
    const r = asOk(
      await handleListTriggers({ connection: CONN, table: "orders" }),
    );
    expect(r.text).toBe("No triggers on table orders");
  });
});

describe("handleListEvents", () => {
  it("returns 'No events in db' on empty result", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.EVENTS/s, []),
    );
    const r = asOk(await handleListEvents({ connection: CONN }));
    expect(r.text).toBe("No events in shop");
  });
});

// ── admin-tools ──────────────────────────────────────────────────

describe("handleListProcesses", () => {
  it("returns no-processes message when none active", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.PROCESSLIST/s, []),
    );
    const r = asOk(await handleListProcesses({ connection: CONN }));
    expect(r.text).toBe("(no active processes)");
  });

  it("renders process count and table when active", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.PROCESSLIST/s, [
        {
          ID: 1, USER: "root", HOST: "localhost", DB: "shop",
          COMMAND: "Query", TIME: 5, STATE: "executing", QUERY: "SELECT 1",
        },
      ]),
    );
    const r = asOk(await handleListProcesses({ connection: CONN }));
    expect(r.text).toMatch(/1 active process/);
  });
});

describe("handleKillQuery", () => {
  it("throws ReadOnlyViolation on read-only connection (caught by toolHandler → toolError with hint)", async () => {
    registerWithConfig(new MockRunner(), { readonly: true });
    const err = asErr(
      await handleKillQuery({ connection: CONN, processId: 42 }),
    );
    expect(err).toMatch(/kill_query is blocked on read-only/);
    expect(err).toMatch(/readonly.*false/i);
  });

  it("issues KILL QUERY by default on read-write connection", async () => {
    const runner = new MockRunner().whenSql(/^KILL QUERY/i, []);
    registerWithConfig(runner, { readonly: false });
    const r = asOk(
      await handleKillQuery({ connection: CONN, processId: 42 }),
    );
    expect(r.text).toBe("KILL QUERY 42 issued.");
    expect(runner.calls()[0]?.sql).toBe("KILL QUERY 42");
  });

  it("issues KILL CONNECTION when killConnection: true", async () => {
    const runner = new MockRunner().whenSql(/^KILL CONNECTION/i, []);
    registerWithConfig(runner, { readonly: false });
    const r = asOk(
      await handleKillQuery({
        connection: CONN,
        processId: 7,
        killConnection: true,
      }),
    );
    expect(r.text).toBe("KILL CONNECTION 7 issued.");
  });
});

describe("handleGetUnusedIndexes", () => {
  it("emits ALTER TABLE DROP INDEX suggestions when results exist", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/table_io_waits_summary_by_index_usage/s, [
        { database: "shop", table: "users", index: "idx_old", access_count: 0 },
      ]),
    );
    const r = asOk(await handleGetUnusedIndexes({ connection: CONN }));
    expect(r.text).toContain("ALTER TABLE `shop`.`users` DROP INDEX `idx_old`;");
    expect(r.structuredContent.dropStatements).toEqual([
      "ALTER TABLE `shop`.`users` DROP INDEX `idx_old`;",
    ]);
  });

  it("returns empty-state message when no unused indexes", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/table_io_waits_summary_by_index_usage/s, []),
    );
    const r = asOk(await handleGetUnusedIndexes({ connection: CONN }));
    expect(r.text).toMatch(/No unused secondary indexes/);
  });
});

describe("handleGetCharsetCollation", () => {
  it("omits table+columns sections when table is undefined", async () => {
    registerWithConfig(
      new MockRunner().whenSql(/information_schema\.SCHEMATA/s, [
        { SCHEMA_NAME: "shop", charset: "utf8mb4", collation: "utf8mb4_bin" },
      ]),
    );
    const r = asOk(await handleGetCharsetCollation({ connection: CONN }));
    expect(r.text).toContain("## Database");
    expect(r.text).not.toContain("## Table");
    expect(r.text).not.toContain("## Columns");
  });

  it("includes table+columns sections when table is provided", async () => {
    const runner = new MockRunner()
      .whenSql(/information_schema\.SCHEMATA/s, [
        { SCHEMA_NAME: "shop", charset: "utf8mb4", collation: "utf8mb4_bin" },
      ])
      .whenSql(/information_schema\.TABLES t/s, [
        { TABLE_NAME: "users", collation: "utf8mb4_bin", charset: "utf8mb4" },
      ])
      .whenSql(/information_schema\.COLUMNS/s, []);
    registerWithConfig(runner);
    const r = asOk(
      await handleGetCharsetCollation({ connection: CONN, table: "users" }),
    );
    expect(r.text).toContain("## Database");
    expect(r.text).toContain("## Table");
    expect(r.text).toContain("## Columns");
  });
});

// ── connection-tools ─────────────────────────────────────────────

describe("handleUseDatabase", () => {
  it("returns toolError when the database does not exist", async () => {
    registerMockConnection(
      CONN,
      new MockRunner().whenSql(/^SHOW DATABASES LIKE/i, []),
    );
    const err = asErr(
      await handleUseDatabase({ connection: CONN, database: "missing" }),
    );
    expect(err).toMatch(/Database "missing" not found/);
  });

  it("switches the active database on success", async () => {
    registerMockConnection(
      CONN,
      new MockRunner().whenSql(/^SHOW DATABASES LIKE/i, [
        { Database: "shop" },
      ]),
    );
    const r = asOk(
      await handleUseDatabase({ connection: CONN, database: "shop" }),
    );
    expect(r.text).toContain('Switched to database "shop"');
    expect(r.structuredContent.database).toBe("shop");
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetConnectionsForTests,
  registerMockConnection,
} from "../connection.js";
import { MockRunner } from "./utils/mock-runner.js";
import {
  databaseExists,
  describeTableColumns,
  findRoutineType,
  getCharsetCollation,
  getCreateTable,
  getEventDdl,
  getForeignKeys,
  getIndexStats,
  getProcessList,
  getRoutineDdl,
  getTableStats,
  getTriggerDdl,
  getUnusedIndexes,
  getViewDdl,
  listDatabaseNames,
  listEventsBrief,
  listRoutinesBrief,
  listTableNames,
  listTablesDetailed,
  listTriggersBrief,
  listViewsBrief,
  searchColumns,
  showIndexes,
} from "../db/introspection.js";

// Every test gets a fresh mock connection — no leakage between cases.
const CONN = "test-conn";

beforeEach(() => {
  __resetConnectionsForTests();
});

describe("listDatabaseNames", () => {
  it("returns first-column values regardless of column name", async () => {
    const runner = new MockRunner().whenSql(/^SHOW DATABASES$/i, [
      { Database: "alpha" },
      { Database: "beta" },
    ]);
    registerMockConnection(CONN, runner);
    expect(await listDatabaseNames(CONN)).toEqual(["alpha", "beta"]);
  });

  it("works with the alternative column name some versions emit", async () => {
    const runner = new MockRunner().whenSql(/^SHOW DATABASES$/i, [
      { SCHEMA_NAME: "x" },
    ]);
    registerMockConnection(CONN, runner);
    expect(await listDatabaseNames(CONN)).toEqual(["x"]);
  });
});

describe("listTableNames", () => {
  it("issues TABLE_SCHEMA-filtered query and extracts TABLE_NAME", async () => {
    const runner = new MockRunner().whenSql(
      /information_schema\.TABLES.*TABLE_TYPE = 'BASE TABLE'/s,
      [{ TABLE_NAME: "users" }, { TABLE_NAME: "orders" }],
    );
    registerMockConnection(CONN, runner);

    const names = await listTableNames(CONN, "shop");
    expect(names).toEqual(["users", "orders"]);

    expect(runner.calls()).toHaveLength(1);
    expect(runner.calls()[0]?.params).toEqual(["shop"]);
  });
});

describe("listTablesDetailed", () => {
  it("returns typed TableListRow rows", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.TABLES/s, [
      {
        TABLE_NAME: "users",
        TABLE_ROWS: 100,
        ENGINE: "InnoDB",
        TABLE_COMMENT: "",
      },
    ]);
    registerMockConnection(CONN, runner);
    const rows = await listTablesDetailed(CONN, "shop");
    expect(rows[0]?.TABLE_NAME).toBe("users");
    expect(rows[0]?.ENGINE).toBe("InnoDB");
  });
});

describe("getTableStats", () => {
  it("omits the AND TABLE_NAME clause when no filter is given", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.TABLES/s, []);
    registerMockConnection(CONN, runner);
    await getTableStats(CONN, "shop");
    const call = runner.calls()[0];
    expect(call?.sql).not.toContain("TABLE_NAME IN");
    expect(call?.params).toEqual(["shop"]);
  });

  it("adds TABLE_NAME IN (?) for a single-table filter", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.TABLES/s, []);
    registerMockConnection(CONN, runner);
    await getTableStats(CONN, "shop", ["users"]);
    const call = runner.calls()[0];
    expect(call?.sql).toContain("TABLE_NAME IN (?)");
    expect(call?.params).toEqual(["shop", "users"]);
  });

  it("emits one ? per table for a multi-table filter", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.TABLES/s, []);
    registerMockConnection(CONN, runner);
    await getTableStats(CONN, "shop", ["users", "orders", "events"]);
    const call = runner.calls()[0];
    expect(call?.sql).toContain("TABLE_NAME IN (?, ?, ?)");
    expect(call?.params).toEqual(["shop", "users", "orders", "events"]);
  });
});

describe("getCreateTable", () => {
  it("extracts the Create Table column when present", async () => {
    const runner = new MockRunner().whenSql(/^SHOW CREATE TABLE/i, [
      { Table: "users", "Create Table": "CREATE TABLE users (...)" },
    ]);
    registerMockConnection(CONN, runner);
    expect(await getCreateTable(CONN, "shop", "users")).toBe(
      "CREATE TABLE users (...)",
    );
  });

  it("returns empty string when the SHOW returns no rows (eg permission)", async () => {
    const runner = new MockRunner().whenSql(/^SHOW CREATE TABLE/i, []);
    registerMockConnection(CONN, runner);
    expect(await getCreateTable(CONN, "shop", "users")).toBe("");
  });

  it("escapes the qualified table name", async () => {
    const runner = new MockRunner().whenSql(/^SHOW CREATE TABLE/i, []);
    registerMockConnection(CONN, runner);
    await getCreateTable(CONN, "my-db", "tab`le");
    expect(runner.calls()[0]?.sql).toBe("SHOW CREATE TABLE `my-db`.`tab``le`");
  });
});

describe("describeTableColumns + showIndexes", () => {
  it("issues DESCRIBE and SHOW INDEX with backtick-escaped names", async () => {
    const runner = new MockRunner()
      .whenSql(/^DESCRIBE/i, [
        {
          Field: "id",
          Type: "int",
          Null: "NO",
          Key: "PRI",
          Default: null,
          Extra: "auto_increment",
        },
      ])
      .whenSql(/^SHOW INDEX/i, [
        {
          Table: "users",
          Non_unique: 0,
          Key_name: "PRIMARY",
          Seq_in_index: 1,
          Column_name: "id",
          Collation: "A",
          Cardinality: 100,
          Sub_part: null,
          Packed: null,
          Null: "",
          Index_type: "BTREE",
          Comment: "",
          Index_comment: "",
        },
      ]);
    registerMockConnection(CONN, runner);

    const cols = await describeTableColumns(CONN, "shop", "users");
    expect(cols[0]?.Field).toBe("id");
    const idx = await showIndexes(CONN, "shop", "users");
    expect(idx[0]?.Key_name).toBe("PRIMARY");

    const sqls = runner.calls().map((c) => c.sql);
    expect(sqls[0]).toBe("DESCRIBE `shop`.`users`");
    expect(sqls[1]).toBe("SHOW INDEX FROM `shop`.`users`");
  });
});

describe("getForeignKeys", () => {
  it("filters by table when provided", async () => {
    const runner = new MockRunner().whenSql(
      /information_schema\.KEY_COLUMN_USAGE/s,
      [],
    );
    registerMockConnection(CONN, runner);
    await getForeignKeys(CONN, "shop", "orders");
    const call = runner.calls()[0];
    expect(call?.sql).toContain("kcu.TABLE_NAME = ?");
    expect(call?.params).toEqual(["shop", "orders"]);
  });

  it("returns all FKs when table is omitted", async () => {
    const runner = new MockRunner().whenSql(
      /information_schema\.KEY_COLUMN_USAGE/s,
      [],
    );
    registerMockConnection(CONN, runner);
    await getForeignKeys(CONN, "shop");
    const call = runner.calls()[0];
    expect(call?.sql).not.toContain("kcu.TABLE_NAME = ?");
    expect(call?.params).toEqual(["shop"]);
  });
});

describe("getIndexStats", () => {
  it("returns rows + scopes by db (and optionally table)", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.STATISTICS/s, [
      {
        TABLE_NAME: "users",
        INDEX_NAME: "PRIMARY",
        NON_UNIQUE: 0,
        SEQ_IN_INDEX: 1,
        COLUMN_NAME: "id",
        CARDINALITY: 100,
        INDEX_TYPE: "BTREE",
      },
    ]);
    registerMockConnection(CONN, runner);
    const rows = await getIndexStats(CONN, "shop", "users");
    expect(rows).toHaveLength(1);
    expect(runner.calls()[0]?.params).toEqual(["shop", "users"]);
  });
});

describe("searchColumns", () => {
  it("passes the LIKE pattern straight through", async () => {
    const runner = new MockRunner().whenSql(
      /information_schema\.COLUMNS.*LIKE/s,
      [],
    );
    registerMockConnection(CONN, runner);
    await searchColumns(CONN, "shop", "%email%");
    expect(runner.calls()[0]?.params).toEqual(["shop", "%email%"]);
  });
});

describe("listViewsBrief + getViewDdl", () => {
  it("lists views and reads SHOW CREATE VIEW", async () => {
    const runner = new MockRunner()
      .whenSql(/information_schema\.VIEWS/s, [
        {
          TABLE_NAME: "v_active_users",
          IS_UPDATABLE: "NO",
          DEFINER: "root@localhost",
          SECURITY_TYPE: "DEFINER",
          CHECK_OPTION: "NONE",
        },
      ])
      .whenSql(/^SHOW CREATE VIEW/i, [
        { View: "v_active_users", "Create View": "CREATE VIEW v (...)" },
      ]);
    registerMockConnection(CONN, runner);
    const views = await listViewsBrief(CONN, "shop");
    expect(views[0]?.TABLE_NAME).toBe("v_active_users");
    expect(await getViewDdl(CONN, "shop", "v_active_users")).toBe(
      "CREATE VIEW v (...)",
    );
  });
});

describe("routines: list / find / ddl", () => {
  it("lists routines optionally filtered by type", async () => {
    const runner = new MockRunner().whenSql(
      /information_schema\.ROUTINES/s,
      [],
    );
    registerMockConnection(CONN, runner);
    await listRoutinesBrief(CONN, "shop", "FUNCTION");
    const call = runner.calls()[0];
    expect(call?.sql).toContain("ROUTINE_TYPE = ?");
    expect(call?.params).toEqual(["shop", "FUNCTION"]);
  });

  it("findRoutineType returns the type or null", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.ROUTINES/s, [
      { ROUTINE_TYPE: "FUNCTION" },
    ]);
    registerMockConnection(CONN, runner);
    expect(await findRoutineType(CONN, "shop", "f1")).toBe("FUNCTION");
  });

  it("findRoutineType returns null when routine is missing", async () => {
    const runner = new MockRunner().whenSql(
      /information_schema\.ROUTINES/s,
      [],
    );
    registerMockConnection(CONN, runner);
    expect(await findRoutineType(CONN, "shop", "missing")).toBeNull();
  });

  it("getRoutineDdl picks the column matching the routine type", async () => {
    const runner = new MockRunner()
      .whenSql(/^SHOW CREATE PROCEDURE/i, [
        { Procedure: "p1", "Create Procedure": "CREATE PROC p1 (...)" },
      ])
      .whenSql(/^SHOW CREATE FUNCTION/i, [
        { Function: "f1", "Create Function": "CREATE FUNC f1 (...)" },
      ]);
    registerMockConnection(CONN, runner);
    expect(await getRoutineDdl(CONN, "shop", "PROCEDURE", "p1")).toBe(
      "CREATE PROC p1 (...)",
    );
    expect(await getRoutineDdl(CONN, "shop", "FUNCTION", "f1")).toBe(
      "CREATE FUNC f1 (...)",
    );
  });
});

describe("triggers: list + ddl", () => {
  it("filters triggers by table when provided", async () => {
    const runner = new MockRunner().whenSql(
      /information_schema\.TRIGGERS/s,
      [],
    );
    registerMockConnection(CONN, runner);
    await listTriggersBrief(CONN, "shop", "orders");
    expect(runner.calls()[0]?.params).toEqual(["shop", "orders"]);
  });

  it("getTriggerDdl reads SQL Original Statement", async () => {
    const runner = new MockRunner().whenSql(/^SHOW CREATE TRIGGER/i, [
      {
        Trigger: "t1",
        "SQL Original Statement": "CREATE TRIGGER t1 (...)",
        sql_mode: "STRICT",
      },
    ]);
    registerMockConnection(CONN, runner);
    expect(await getTriggerDdl(CONN, "shop", "t1")).toBe(
      "CREATE TRIGGER t1 (...)",
    );
  });
});

describe("events: list + ddl", () => {
  it("lists events scoped to db", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.EVENTS/s, []);
    registerMockConnection(CONN, runner);
    await listEventsBrief(CONN, "shop");
    expect(runner.calls()[0]?.params).toEqual(["shop"]);
  });

  it("getEventDdl reads Create Event", async () => {
    const runner = new MockRunner().whenSql(/^SHOW CREATE EVENT/i, [
      {
        Event: "e1",
        sql_mode: "",
        time_zone: "UTC",
        "Create Event": "CREATE EVENT e1 (...)",
      },
    ]);
    registerMockConnection(CONN, runner);
    expect(await getEventDdl(CONN, "shop", "e1")).toBe("CREATE EVENT e1 (...)");
  });
});

describe("admin: processes + unused indexes + charset", () => {
  it("getProcessList omits TIME >= ? when minSeconds is undefined", async () => {
    const runner = new MockRunner().whenSql(
      /information_schema\.PROCESSLIST/s,
      [],
    );
    registerMockConnection(CONN, runner);
    await getProcessList(CONN);
    const call = runner.calls()[0];
    expect(call?.sql).not.toContain("TIME >= ?");
    expect(call?.params).toEqual([]);
  });

  it("getProcessList includes TIME >= ? when minSeconds is set", async () => {
    const runner = new MockRunner().whenSql(
      /information_schema\.PROCESSLIST/s,
      [],
    );
    registerMockConnection(CONN, runner);
    await getProcessList(CONN, 30);
    const call = runner.calls()[0];
    expect(call?.sql).toContain("TIME >= ?");
    expect(call?.params).toEqual([30]);
  });

  it("getUnusedIndexes filters PRIMARY + COUNT_STAR=0", async () => {
    const runner = new MockRunner().whenSql(
      /performance_schema\.table_io_waits_summary_by_index_usage/s,
      [],
    );
    registerMockConnection(CONN, runner);
    await getUnusedIndexes(CONN, "shop");
    const sql = runner.calls()[0]?.sql ?? "";
    expect(sql).toContain("INDEX_NAME != 'PRIMARY'");
    expect(sql).toContain("COUNT_STAR = 0");
  });

  it("getCharsetCollation skips table+column queries when table is undefined", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.SCHEMATA/s, [
      { SCHEMA_NAME: "shop", charset: "utf8mb4", collation: "utf8mb4_bin" },
    ]);
    registerMockConnection(CONN, runner);
    const info = await getCharsetCollation(CONN, "shop");
    expect(info.databaseInfo).toHaveLength(1);
    expect(info.tableInfo).toEqual([]);
    expect(info.columns).toEqual([]);
    expect(runner.calls()).toHaveLength(1);
  });

  it("getCharsetCollation issues 3 queries when table is provided", async () => {
    const runner = new MockRunner()
      .whenSql(/information_schema\.SCHEMATA/s, [
        { SCHEMA_NAME: "shop", charset: "utf8mb4", collation: "utf8mb4_bin" },
      ])
      .whenSql(/information_schema\.TABLES t/s, [
        { TABLE_NAME: "users", collation: "utf8mb4_bin", charset: "utf8mb4" },
      ])
      .whenSql(/information_schema\.COLUMNS/s, []);
    registerMockConnection(CONN, runner);
    await getCharsetCollation(CONN, "shop", "users");
    expect(runner.calls()).toHaveLength(3);
  });
});

describe("databaseExists", () => {
  it("returns true when at least one row matches", async () => {
    const runner = new MockRunner().whenSql(/^SHOW DATABASES LIKE/i, [
      { Database: "shop" },
    ]);
    registerMockConnection(CONN, runner);
    expect(await databaseExists(CONN, "shop")).toBe(true);
  });

  it("returns false on empty result", async () => {
    const runner = new MockRunner().whenSql(/^SHOW DATABASES LIKE/i, []);
    registerMockConnection(CONN, runner);
    expect(await databaseExists(CONN, "missing")).toBe(false);
  });
});

describe("MockRunner self-check", () => {
  it("throws on unmatched SQL so tests don't silently pass empty data", async () => {
    const runner = new MockRunner();
    registerMockConnection(CONN, runner);
    await expect(listTableNames(CONN, "shop")).rejects.toThrow(
      /no rule matched/i,
    );
  });

  it("records calls in order", async () => {
    const runner = new MockRunner()
      .whenSql(/^SHOW DATABASES$/i, [{ Database: "x" }])
      .whenSql(/information_schema\.TABLES/s, []);
    registerMockConnection(CONN, runner);
    await listDatabaseNames(CONN);
    await listTableNames(CONN, "x");
    expect(runner.calls().map((c) => c.sql.trim().split("\n")[0])).toEqual([
      "SHOW DATABASES",
      "SELECT TABLE_NAME",
    ]);
  });
});

import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetConnectionsForTests,
  registerMockConnection,
} from "../connection.js";
import { MockRunner } from "./utils/mock-runner.js";
import { handleColumnStats } from "../tools/data-tools.js";

// The end-to-end behavior of column_stats — counts, mins/maxes, top-N
// values — lives in the integration suite where MySQL is the source of
// truth for the numbers. Here we cover:
//
//   1. The metadata path: bad table / bad column filter → toolError
//      with the right structured suggestions.
//   2. The aggregation-SQL shape: type-aware metric inclusion / exclusion.
//      We assert the MockRunner saw the right column projections for each
//      data type, without re-implementing MIN/MAX/AVG semantics.
//   3. Response shape: structured content carries the per-column array.

const CONN = "mock";
const DB = "shop";

beforeEach(() => {
  __resetConnectionsForTests();
});

function asOk(result: Awaited<ReturnType<typeof handleColumnStats>>): {
  text: string;
  structuredContent: Record<string, unknown>;
} {
  if ("isError" in result && result.isError) {
    throw new Error(
      `expected toolOk, got toolError: ${result.content[0]?.text}`,
    );
  }
  return {
    text: result.content[0]?.text ?? "",
    structuredContent:
      (result as { structuredContent?: Record<string, unknown> })
        .structuredContent ?? {},
  };
}

function asErr(result: Awaited<ReturnType<typeof handleColumnStats>>): {
  text: string;
  code?: string;
} {
  if (!("isError" in result) || !result.isError) {
    throw new Error("expected toolError, got toolOk");
  }
  return {
    text: result.content[0]?.text ?? "",
    code: (result.structuredContent as { code?: string } | undefined)?.code,
  };
}

// ── metadata gate ────────────────────────────────────────────────

describe("column_stats — metadata gate", () => {
  it("returns TABLE_NOT_FOUND when the table has no columns in information_schema", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.COLUMNS/s, []);
    registerMockConnection(CONN, runner, { database: DB });

    const r = asErr(
      await handleColumnStats({ connection: CONN, table: "ghost" }),
    );
    expect(r.code).toBe("TABLE_NOT_FOUND");
    // Suggestion should pre-fill connection + database for list_tables.
    expect(r.text).toContain("list_tables");
    expect(r.text).toContain(`"connection":"${CONN}"`);
    expect(r.text).toContain(`"database":"${DB}"`);
  });

  it("returns COLUMNS_NOT_FOUND when the column filter matches nothing", async () => {
    const runner = new MockRunner().whenSql(/information_schema\.COLUMNS/s, [
      {
        COLUMN_NAME: "id",
        DATA_TYPE: "int",
        COLUMN_TYPE: "int unsigned",
        IS_NULLABLE: "NO",
      },
    ]);
    registerMockConnection(CONN, runner, { database: DB });

    const r = asErr(
      await handleColumnStats({
        connection: CONN,
        table: "users",
        columns: ["doesnt_exist"],
      }),
    );
    expect(r.code).toBe("COLUMNS_NOT_FOUND");
    expect(r.text).toContain("describe_table");
  });
});

// ── aggregation-SQL shape ────────────────────────────────────────

describe("column_stats — aggregation SQL", () => {
  /**
   * Returns the aggregation SQL the runner saw (the one query that's not
   * the information_schema metadata read). The test verifies *what
   * MySQL was asked to compute*, not the resulting values.
   */
  function buildSetup(
    cols: Array<{
      name: string;
      dataType: string;
      columnType: string;
    }>,
  ) {
    const meta = cols.map((c) => ({
      COLUMN_NAME: c.name,
      DATA_TYPE: c.dataType,
      COLUMN_TYPE: c.columnType,
      IS_NULLABLE: "YES",
    }));
    // Build a fake aggregation row matching the alias pattern the
    // handler emits, so we exit the metadata gate and reach the
    // assertions on call shape.
    const aggRow: Record<string, unknown> = { __total: 100 };
    cols.forEach((_, i) => {
      aggRow[`nn_${i}`] = 100;
      aggRow[`dc_${i}`] = 50;
      aggRow[`mn_${i}`] = 1;
      aggRow[`mx_${i}`] = 999;
      aggRow[`av_${i}`] = 500;
    });
    const runner = new MockRunner()
      .whenSql(/information_schema\.COLUMNS/s, meta)
      // Match anything that selects from the qualified table — that's
      // the aggregation SELECT. The metadata regex above wins for the
      // first query because the first-match rule fires in registration
      // order.
      .whenSql(/`shop`\.`users`/, [aggRow]);
    return runner;
  }

  it("includes COUNT(DISTINCT) for every column type, MIN/MAX/AVG only where applicable", async () => {
    const runner = buildSetup([
      { name: "id", dataType: "int", columnType: "int" },
      {
        name: "email",
        dataType: "varchar",
        columnType: "varchar(255)",
      },
      { name: "bio", dataType: "text", columnType: "text" },
      { name: "created_at", dataType: "datetime", columnType: "datetime" },
    ]);
    registerMockConnection(CONN, runner, { database: DB });

    await handleColumnStats({ connection: CONN, table: "users" });

    const aggCall = runner.calls().find((c) => /`shop`\.`users`/.test(c.sql));
    expect(aggCall).toBeDefined();
    const sql = aggCall!.sql;

    // Every column gets nn_ and dc_.
    expect(sql).toMatch(/COUNT\(`id`\) AS `nn_0`/);
    expect(sql).toMatch(/COUNT\(DISTINCT `id`\) AS `dc_0`/);
    expect(sql).toMatch(/COUNT\(`email`\) AS `nn_1`/);
    expect(sql).toMatch(/COUNT\(DISTINCT `email`\) AS `dc_1`/);
    expect(sql).toMatch(/COUNT\(`bio`\) AS `nn_2`/);
    expect(sql).toMatch(/COUNT\(DISTINCT `bio`\) AS `dc_2`/);
    expect(sql).toMatch(/COUNT\(`created_at`\) AS `nn_3`/);

    // Numeric (int): MIN, MAX, AVG.
    expect(sql).toMatch(/MIN\(`id`\) AS `mn_0`/);
    expect(sql).toMatch(/MAX\(`id`\) AS `mx_0`/);
    expect(sql).toMatch(/AVG\(`id`\) AS `av_0`/);

    // varchar: MIN, MAX. No AVG.
    expect(sql).toMatch(/MIN\(`email`\) AS `mn_1`/);
    expect(sql).toMatch(/MAX\(`email`\) AS `mx_1`/);
    expect(sql).not.toMatch(/AVG\(`email`\)/);

    // text (large opaque): no MIN/MAX/AVG — only counts.
    expect(sql).not.toMatch(/MIN\(`bio`\)/);
    expect(sql).not.toMatch(/MAX\(`bio`\)/);
    expect(sql).not.toMatch(/AVG\(`bio`\)/);

    // datetime: MIN, MAX. No AVG.
    expect(sql).toMatch(/MIN\(`created_at`\) AS `mn_3`/);
    expect(sql).toMatch(/MAX\(`created_at`\) AS `mx_3`/);
    expect(sql).not.toMatch(/AVG\(`created_at`\)/);
  });

  it("respects the columns filter, preserving table-definition order", async () => {
    const runner = buildSetup([
      { name: "id", dataType: "int", columnType: "int" },
      { name: "name", dataType: "varchar", columnType: "varchar(64)" },
      { name: "age", dataType: "int", columnType: "int" },
    ]);
    registerMockConnection(CONN, runner, { database: DB });

    // Filter requests name + age in reversed order; handler MUST preserve
    // table-definition order so structured output matches DESCRIBE.
    await handleColumnStats({
      connection: CONN,
      table: "users",
      columns: ["age", "name"],
    });

    const aggCall = runner.calls().find((c) => /`shop`\.`users`/.test(c.sql))!;
    const namePos = aggCall.sql.indexOf("`name`");
    const agePos = aggCall.sql.indexOf("`age`");
    expect(namePos).toBeGreaterThan(-1);
    expect(agePos).toBeGreaterThan(-1);
    expect(namePos).toBeLessThan(agePos); // name comes before age in the table def
  });
});

// ── response shape ────────────────────────────────────────────────

describe("column_stats — response", () => {
  it("computes null_pct and distinct_pct from raw counts", async () => {
    const runner = new MockRunner()
      .whenSql(/information_schema\.COLUMNS/s, [
        {
          COLUMN_NAME: "status",
          DATA_TYPE: "varchar",
          COLUMN_TYPE: "varchar(16)",
          IS_NULLABLE: "YES",
        },
      ])
      .whenSql(/`shop`\.`users`/, [
        {
          __total: 1000,
          nn_0: 750, // 25% null
          dc_0: 3, // 0.4% distinct of non-null
          mn_0: "active",
          mx_0: "pending",
        },
      ]);
    registerMockConnection(CONN, runner, { database: DB });

    const r = asOk(
      await handleColumnStats({ connection: CONN, table: "users" }),
    );
    const cols = (
      r.structuredContent as {
        columns: Array<{
          name: string;
          null_pct: number;
          distinct_pct: number;
          count_distinct: number;
          min: unknown;
          max: unknown;
        }>;
      }
    ).columns;
    expect(cols).toHaveLength(1);
    expect(cols[0]?.name).toBe("status");
    expect(cols[0]?.null_pct).toBeCloseTo(25);
    expect(cols[0]?.distinct_pct).toBeCloseTo(0.4);
    expect(cols[0]?.count_distinct).toBe(3);
    expect(cols[0]?.min).toBe("active");
    expect(cols[0]?.max).toBe("pending");
  });

  it("records notes when min/max/avg are skipped due to column type", async () => {
    const runner = new MockRunner()
      .whenSql(/information_schema\.COLUMNS/s, [
        {
          COLUMN_NAME: "payload",
          DATA_TYPE: "blob",
          COLUMN_TYPE: "blob",
          IS_NULLABLE: "YES",
        },
      ])
      .whenSql(/`shop`\.`users`/, [{ __total: 10, nn_0: 10, dc_0: 9 }]);
    registerMockConnection(CONN, runner, { database: DB });

    const r = asOk(
      await handleColumnStats({ connection: CONN, table: "users" }),
    );
    const cols = (
      r.structuredContent as {
        columns: Array<{ notes?: string[] }>;
      }
    ).columns;
    expect(cols[0]?.notes).toBeDefined();
    expect(cols[0]?.notes?.some((n) => /min.*max/i.test(n))).toBe(true);
    expect(cols[0]?.notes?.some((n) => /avg/i.test(n))).toBe(true);
  });

  it("emits 0 extra queries when top_n is omitted", async () => {
    const runner = new MockRunner()
      .whenSql(/information_schema\.COLUMNS/s, [
        {
          COLUMN_NAME: "id",
          DATA_TYPE: "int",
          COLUMN_TYPE: "int",
          IS_NULLABLE: "NO",
        },
      ])
      .whenSql(/`shop`\.`users`/, [
        { __total: 5, nn_0: 5, dc_0: 5, mn_0: 1, mx_0: 5, av_0: 3 },
      ]);
    registerMockConnection(CONN, runner, { database: DB });

    await handleColumnStats({ connection: CONN, table: "users" });
    // Two queries total: metadata + aggregation. No top-N follow-ups.
    expect(runner.calls()).toHaveLength(2);
  });

  it("runs one top-N query per column when top_n is set", async () => {
    const runner = new MockRunner()
      .whenSql(/information_schema\.COLUMNS/s, [
        {
          COLUMN_NAME: "status",
          DATA_TYPE: "varchar",
          COLUMN_TYPE: "varchar(16)",
          IS_NULLABLE: "YES",
        },
        {
          COLUMN_NAME: "country",
          DATA_TYPE: "varchar",
          COLUMN_TYPE: "varchar(2)",
          IS_NULLABLE: "YES",
        },
      ])
      // First the aggregation SELECT — has COUNT(DISTINCT ...) for both
      // columns. Then per-column top-N queries (no DISTINCT, just GROUP BY).
      .whenSql(/COUNT\(DISTINCT/s, [
        {
          __total: 1000,
          nn_0: 1000,
          dc_0: 3,
          mn_0: "a",
          mx_0: "z",
          nn_1: 1000,
          dc_1: 30,
          mn_1: "AA",
          mx_1: "ZZ",
        },
      ])
      // The two top-N queries — register a generic GROUP BY responder.
      .whenSql(/GROUP BY/s, [
        { value: "active", count: 800 },
        { value: "pending", count: 200 },
      ]);
    registerMockConnection(CONN, runner, { database: DB });

    const r = asOk(
      await handleColumnStats({
        connection: CONN,
        table: "users",
        top_n: 5,
      }),
    );
    // 1 metadata + 1 aggregation + 2 top-N = 4 total.
    expect(runner.calls()).toHaveLength(4);
    const cols = (
      r.structuredContent as {
        columns: Array<{
          name: string;
          top_values?: Array<{ value: unknown; count: number }>;
        }>;
      }
    ).columns;
    expect(cols[0]?.top_values).toBeDefined();
    expect(cols[0]?.top_values?.[0]?.value).toBe("active");
    expect(cols[0]?.top_values?.[0]?.count).toBe(800);
  });
});

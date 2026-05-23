import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWithTimeout } from "../connection.js";
import { escapeId, qualifiedTable } from "../sql/identifiers.js";
import { resolveDb } from "../db/resolve.js";
import { getTableStats } from "../db/introspection.js";
import { formatAsTable, humanSize } from "../format.js";
import {
  toolError,
  toolOk,
  toolHandler,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../tool-runtime.js";

export const handleGetTableStats = toolHandler(
  "get_table_stats",
  async ({
    connection,
    database,
    table,
  }: {
    connection: string;
    database?: string | undefined;
    table?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const tables = await getTableStats(connection, r.db, table);
    if (tables.length === 0) {
      return toolOk("No tables found", { database: r.db, tables: [] });
    }

    const formatted = tables.map((t) => ({
      TABLE_NAME: t.TABLE_NAME,
      ROWS: t.TABLE_ROWS,
      DATA_SIZE: humanSize(t.DATA_LENGTH),
      INDEX_SIZE: humanSize(t.INDEX_LENGTH),
      TOTAL_SIZE: humanSize((t.DATA_LENGTH ?? 0) + (t.INDEX_LENGTH ?? 0)),
      AUTO_INC: t.AUTO_INCREMENT ?? "N/A",
      ENGINE: t.ENGINE,
      CREATED: t.CREATE_TIME ?? "N/A",
      UPDATED: t.UPDATE_TIME ?? "N/A",
    }));

    return toolOk(
      formatAsTable(formatted) + `\n\n${tables.length} table(s) in ${r.db}`,
      { database: r.db, tables },
    );
  },
);

// ── column_stats ────────────────────────────────────────────────────

/**
 * Per-column metrics we can compute on a single table scan:
 *
 *   - count_total: COUNT(*) — total rows in the table
 *   - count_non_null: COUNT(`col`) — non-null values
 *   - null_pct: derived from the above
 *   - count_distinct: COUNT(DISTINCT `col`) — cardinality
 *   - distinct_pct: derived
 *   - min / max: lexicographic for strings, numeric/temporal for the rest
 *   - avg: numeric types only
 *   - top_values: optional separate per-column query
 */

/** MySQL DATA_TYPE values for which AVG(col) makes sense. */
const NUMERIC_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "bigint",
  "decimal",
  "numeric",
  "float",
  "double",
  "bit",
  "year",
]);

/** Types where MIN / MAX produce a useful comparable value. */
const COMPARABLE_TYPES = new Set([
  ...NUMERIC_TYPES,
  "date",
  "datetime",
  "timestamp",
  "time",
  "char",
  "varchar",
  "enum",
  "set",
]);

/** Skip MIN / MAX / AVG on these — a single row can be megabytes. */
const LARGE_OPAQUE_TYPES = new Set([
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
  "binary",
  "varbinary",
  "json",
  "geometry",
  "point",
  "linestring",
  "polygon",
  "multipoint",
  "multilinestring",
  "multipolygon",
  "geometrycollection",
]);

interface ColumnMetadataRow {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: "YES" | "NO";
}

interface ColumnStat {
  name: string;
  type: string;
  null_pct: number | null;
  distinct_pct: number | null;
  count_non_null: number;
  count_distinct: number | null;
  min: unknown;
  max: unknown;
  avg: number | null;
  top_values?: Array<{ value: unknown; count: number }>;
  /** Set when a metric was skipped — explains "why no min" for BLOB columns etc. */
  notes?: string[];
}

/**
 * Build the combined aggregation SELECT for one table scan covering all
 * requested columns. The total-count alias is `__total`; per-column
 * aliases use index suffixes (`nn_0`, `dc_0`, `mn_0`, `mx_0`, `av_0`,
 * ...) so we can map back to the original column names without parsing
 * a returned identifier we never controlled.
 */
function buildAggregationSql(
  db: string,
  table: string,
  cols: ColumnMetadataRow[],
): string {
  const parts: string[] = ["COUNT(*) AS `__total`"];
  cols.forEach((c, i) => {
    const escapedCol = escapeId(c.COLUMN_NAME);
    const dt = c.DATA_TYPE.toLowerCase();
    const isLarge = LARGE_OPAQUE_TYPES.has(dt);
    const canCompare = COMPARABLE_TYPES.has(dt) && !isLarge;
    const isNumeric = NUMERIC_TYPES.has(dt);

    parts.push(`COUNT(${escapedCol}) AS \`nn_${i}\``);
    // COUNT(DISTINCT col) is fine on every type — even BLOB. MySQL
    // hashes the comparison so it doesn't materialize the values.
    parts.push(`COUNT(DISTINCT ${escapedCol}) AS \`dc_${i}\``);
    if (canCompare) {
      parts.push(`MIN(${escapedCol}) AS \`mn_${i}\``);
      parts.push(`MAX(${escapedCol}) AS \`mx_${i}\``);
    }
    if (isNumeric) {
      parts.push(`AVG(${escapedCol}) AS \`av_${i}\``);
    }
  });
  return `SELECT ${parts.join(", ")} FROM ${qualifiedTable(db, table)}`;
}

interface AggregationRow {
  __total: number;
  [key: string]: unknown;
}

export const handleColumnStats = toolHandler(
  "column_stats",
  async ({
    connection,
    table,
    columns,
    database,
    top_n,
  }: {
    connection: string;
    table: string;
    columns?: string[] | undefined;
    database?: string | undefined;
    top_n?: number | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    // Pull the type metadata first — we need it to pick which
    // aggregations to compute per column. `COLUMN_TYPE` carries the
    // human-readable form (`varchar(255)`) for the response; `DATA_TYPE`
    // is the bare keyword we branch on.
    const metaRows = await queryWithTimeout<ColumnMetadataRow[]>(
      connection,
      `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [r.db, table],
    );

    if (metaRows.length === 0) {
      return toolError(`Table ${table} has no columns or does not exist`, {
        code: "TABLE_NOT_FOUND",
        hint: "Verify the table exists in this database.",
        suggestions: [
          {
            tool: "list_tables",
            reason: "see every table in this database",
            args: { connection, database: r.db },
          },
          {
            tool: "search_columns",
            reason: "find tables by a column-name pattern",
          },
        ],
      });
    }

    // Honor the optional `columns` filter — order is preserved from the
    // table definition, not from the caller's array, so the response
    // shape matches DESCRIBE / get_ddl output.
    const want = columns && columns.length > 0 ? new Set(columns) : null;
    const targetCols = want
      ? metaRows.filter((c) => want.has(c.COLUMN_NAME))
      : metaRows;

    if (targetCols.length === 0) {
      return toolError(`None of the requested columns exist on ${table}.`, {
        code: "COLUMNS_NOT_FOUND",
        hint: "Inspect the table's columns first.",
        suggestions: [
          {
            tool: "describe_table",
            reason: "list the actual columns on this table",
            args: { connection, database: r.db, table },
          },
        ],
      });
    }

    // One scan, every metric per column.
    const aggSql = buildAggregationSql(r.db, table, targetCols);
    const [aggRow] = await queryWithTimeout<AggregationRow[]>(
      connection,
      aggSql,
    );
    if (!aggRow) {
      // The table exists but no rows came back from a single-row
      // aggregation — that means MySQL returned no result at all,
      // which shouldn't happen on a valid COUNT(*). Surface as an
      // error rather than silently emit zeros.
      return toolError(
        "column_stats aggregation returned no rows — table may have been dropped mid-query.",
        { code: "COLUMN_STATS_NO_ROWS" },
      );
    }

    const total = Number(aggRow["__total"] ?? 0);
    const topN = top_n ?? 0;

    const stats: ColumnStat[] = [];
    for (const [i, c] of targetCols.entries()) {
      const dt = c.DATA_TYPE.toLowerCase();
      const isLarge = LARGE_OPAQUE_TYPES.has(dt);
      const canCompare = COMPARABLE_TYPES.has(dt) && !isLarge;
      const isNumeric = NUMERIC_TYPES.has(dt);

      const nonNull = Number(aggRow[`nn_${i}`] ?? 0);
      const distinct = Number(aggRow[`dc_${i}`] ?? 0);
      const stat: ColumnStat = {
        name: c.COLUMN_NAME,
        type: c.COLUMN_TYPE,
        count_non_null: nonNull,
        null_pct: total === 0 ? null : 100 * (1 - nonNull / total),
        count_distinct: distinct,
        distinct_pct: nonNull === 0 ? null : 100 * (distinct / nonNull),
        min: canCompare ? (aggRow[`mn_${i}`] ?? null) : null,
        max: canCompare ? (aggRow[`mx_${i}`] ?? null) : null,
        avg: isNumeric ? Number(aggRow[`av_${i}`] ?? 0) : null,
      };
      const skipNotes: string[] = [];
      if (!canCompare) {
        skipNotes.push(
          isLarge
            ? `min/max skipped — type \`${dt}\` can be large; query separately if needed`
            : `min/max not meaningful for type \`${dt}\``,
        );
      }
      if (!isNumeric) {
        skipNotes.push(`avg skipped — type \`${dt}\` is not numeric`);
      }
      if (skipNotes.length > 0) stat.notes = skipNotes;
      stats.push(stat);
    }

    // Optional top-N per column. One additional query per column —
    // skipped by default to keep the tool a single-scan operation.
    if (topN > 0) {
      const topNRows = Math.min(topN, 20); // hard cap; 20 is enough for any UI
      for (const stat of stats) {
        // escapeId() inline here satisfies the SQL-template lint rule
        // (it whitelists CallExpression interpolations; a stashed
        // variable looks like a bare identifier to the rule).
        const top = await queryWithTimeout<
          Array<{ value: unknown; count: number }>
        >(
          connection,
          `SELECT ${escapeId(stat.name)} AS value, COUNT(*) AS count
           FROM ${qualifiedTable(r.db, table)}
           GROUP BY ${escapeId(stat.name)}
           ORDER BY count DESC, ${escapeId(stat.name)} ASC
           LIMIT ?`,
          [topNRows],
        );
        stat.top_values = top.map((t) => ({
          value: t.value,
          count: Number(t.count),
        }));
      }
    }

    // Compact rendered form: one row per column with the key metrics.
    // The full top-N + raw min/max lives in structuredContent for
    // clients that consume it.
    const rendered = stats.map((s) => ({
      column: s.name,
      type: s.type,
      null_pct: s.null_pct === null ? "n/a" : s.null_pct.toFixed(2) + "%",
      distinct: s.count_distinct ?? "n/a",
      distinct_pct:
        s.distinct_pct === null ? "n/a" : s.distinct_pct.toFixed(2) + "%",
      min: s.min ?? "n/a",
      max: s.max ?? "n/a",
      avg: s.avg === null ? "n/a" : s.avg.toFixed(2),
    }));

    const text =
      formatAsTable(rendered) +
      `\n\n${total.toLocaleString()} total row(s) in ${qualifiedTable(r.db, table)}` +
      (topN > 0
        ? `\nTop-${topN} values per column attached in structuredContent.top_values.`
        : "");

    return toolOk(text, {
      database: r.db,
      table,
      total_rows: total,
      columns: stats,
    });
  },
);

export function registerDataTools(server: McpServer) {
  server.registerTool(
    "get_table_stats",
    {
      title: "Table statistics",
      description:
        "Show table statistics: row counts, data size, index size, auto_increment, timestamps",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().optional().describe("Database name"),
        table: z
          .string()
          .optional()
          .describe("Table name (omit for all tables)"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetTableStats,
  );

  // ── sample_data ───────────────────────────────────────────────────
  server.registerTool(
    "sample_data",
    {
      title: "Sample rows",
      description: "Get sample rows from a table for quick preview",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z.string().describe("Table name"),
        database: z.string().optional().describe("Database name"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of rows to return (default: 5, max: 100)"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    toolHandler(
      "sample_data",
      async ({ connection, table, database, limit }) => {
        const r = resolveDb(connection, database);
        if ("error" in r) return r.error;
        const n = limit ?? 5;

        // sample_data deliberately returns rows of an unknown schema —
        // the whole point is to preview an arbitrary user table. The
        // concrete-row-type rule (§4.2) doesn't apply here.
        // eslint-disable-next-line local/no-record-unknown-query-result
        const data = await queryWithTimeout<Array<Record<string, unknown>>>(
          connection,
          `SELECT * FROM ${qualifiedTable(r.db, table)} LIMIT ?`,
          [n],
        );

        if (data.length === 0) {
          return toolOk(`Table ${table} is empty`, {
            database: r.db,
            table,
            rows: [],
          });
        }

        return toolOk(
          formatAsTable(data) + `\n\n${data.length} row(s) from ${table}`,
          { database: r.db, table, rows: data },
        );
      },
    ),
  );

  // ── column_stats ──────────────────────────────────────────────────
  server.registerTool(
    "column_stats",
    {
      title: "Column profile",
      description:
        "Per-column metrics on a table — null %, distinct count, min/max/avg, " +
        "and (optionally) top-N most common values. One table scan for the " +
        "core metrics; one extra query per column if top_n is set.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z.string().describe("Table name"),
        database: z
          .string()
          .optional()
          .describe("Database (uses the connection's active db if omitted)"),
        columns: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict to these column names (default: all columns of the table)",
          ),
        top_n: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe(
            "If > 0, include the top-N most common values per column. Capped at 20. " +
              "Adds one query per column.",
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleColumnStats,
  );
}

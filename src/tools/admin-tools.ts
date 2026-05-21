import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConnectionConfig, queryWithTimeout } from "../connection.js";
import {
  formatAsTable,
  resolveDb,
  toolOk,
  toolError,
  toolHandler,
} from "../helpers.js";

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerAdminTools(server: McpServer) {
  // ── list_processes ────────────────────────────────────────────────
  server.registerTool(
    "list_processes",
    {
      title: "List running processes",
      description:
        "Show the MySQL process list (running connections and their current queries). " +
        "Useful for spotting long-running queries before deciding to kill_query.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        minSeconds: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Only show processes running for at least this many seconds"),
      },
      annotations: READ_ONLY,
    },
    toolHandler("list_processes", async ({ connection, minSeconds }) => {
      // information_schema.PROCESSLIST is the structured equivalent of
      // SHOW FULL PROCESSLIST and supports WHERE filtering. The
      // PROCESS privilege is required to see other users' threads;
      // without it the result is limited to the current user.
      let sql = `
        SELECT
          ID,
          USER,
          HOST,
          DB,
          COMMAND,
          TIME,
          STATE,
          INFO AS QUERY
        FROM information_schema.PROCESSLIST
        WHERE COMMAND != 'Sleep'`;
      const params: unknown[] = [];
      if (minSeconds != null) {
        sql += ` AND TIME >= ?`;
        params.push(minSeconds);
      }
      sql += ` ORDER BY TIME DESC`;

      const rows = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        sql,
        params,
      );

      if (rows.length === 0) {
        return toolOk("(no active processes)", { processes: [] });
      }

      return toolOk(
        formatAsTable(rows) + `\n\n${rows.length} active process(es)`,
        { processes: rows },
      );
    }),
  );

  // ── kill_query ────────────────────────────────────────────────────
  server.registerTool(
    "kill_query",
    {
      title: "Kill a running query",
      description:
        "Cancel a running query by its process ID. Use list_processes first to find the ID. " +
        "Gated: only available on connections configured with readonly: false.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        processId: z
          .number()
          .int()
          .positive()
          .describe("Process ID from list_processes (the ID column)"),
        killConnection: z
          .boolean()
          .optional()
          .describe(
            "true → KILL CONNECTION (terminates the whole session). " +
              "false (default) → KILL QUERY (only the running statement).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    toolHandler(
      "kill_query",
      async ({ connection, processId, killConnection }) => {
        const cfg = getConnectionConfig(connection);
        if (cfg.readonly !== false) {
          return toolError(
            `kill_query is blocked on read-only connection "${connection}".`,
            'Set "readonly": false in the connection config to allow administrative operations.',
          );
        }

        const variant = killConnection ? "CONNECTION" : "QUERY";
        // Process IDs come from MySQL itself; we still bound the value
        // (positive integer, z-validated) and inline it as a number —
        // KILL does not accept ? placeholders.
        await queryWithTimeout(
          connection,
          `KILL ${variant} ${Math.trunc(processId)}`,
        );

        return toolOk(`KILL ${variant} ${processId} issued.`, {
          processId,
          variant,
        });
      },
    ),
  );

  // ── get_unused_indexes ────────────────────────────────────────────
  server.registerTool(
    "get_unused_indexes",
    {
      title: "Find unused indexes",
      description:
        "List secondary indexes with zero read activity in performance_schema. " +
        "Primary keys are excluded. Requires performance_schema to be enabled " +
        "(default on MySQL 5.7+) and the server to have been running long enough " +
        "for usage stats to accumulate.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY,
    },
    toolHandler("get_unused_indexes", async ({ connection, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      // performance_schema's index_io_waits_summary records every
      // index access since server start. INDEX_NAME IS NULL is the
      // table scan; we filter it out. PRIMARY is excluded because
      // dropping a PK is usually not what the operator wants.
      const rows = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        `SELECT
           OBJECT_SCHEMA AS \`database\`,
           OBJECT_NAME   AS \`table\`,
           INDEX_NAME    AS \`index\`,
           COUNT_STAR    AS access_count
         FROM performance_schema.table_io_waits_summary_by_index_usage
         WHERE OBJECT_SCHEMA = ?
           AND INDEX_NAME IS NOT NULL
           AND INDEX_NAME != 'PRIMARY'
           AND COUNT_STAR = 0
         ORDER BY OBJECT_NAME, INDEX_NAME`,
        [r.db],
      );

      if (rows.length === 0) {
        return toolOk(
          `No unused secondary indexes detected in ${r.db}.`,
          { database: r.db, unusedIndexes: [] },
        );
      }

      const dropStatements = rows.map(
        (idx) =>
          `ALTER TABLE \`${idx.database}\`.\`${idx.table}\` DROP INDEX \`${idx.index}\`;`,
      );

      const output =
        formatAsTable(rows) +
        `\n\n${rows.length} unused index(es) in ${r.db}\n\n## Suggested DROP statements\n` +
        dropStatements.join("\n") +
        "\n\nCaution: 'unused' = no reads since server start. Verify against your longest expected query cycle before dropping.";

      return toolOk(output, {
        database: r.db,
        unusedIndexes: rows,
        dropStatements,
      });
    }),
  );

  // ── get_charset_collation ─────────────────────────────────────────
  server.registerTool(
    "get_charset_collation",
    {
      title: "Get charset and collation",
      description:
        "Show character set and collation at the database, table, or column level. " +
        "Useful for diagnosing emoji-eating utf8mb3 columns or mixed collations that " +
        "cause 'Illegal mix of collations' errors in JOINs.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().optional().describe("Database name"),
        table: z
          .string()
          .optional()
          .describe("Table name (omit for database-level info)"),
      },
      annotations: READ_ONLY,
    },
    toolHandler(
      "get_charset_collation",
      async ({ connection, database, table }) => {
        const r = resolveDb(connection, database);
        if ("error" in r) return r.error;

        const sections: string[] = [];
        const structured: Record<string, unknown> = { database: r.db };

        // Database-level
        const dbInfo = await queryWithTimeout<Array<Record<string, unknown>>>(
          connection,
          `SELECT
             SCHEMA_NAME,
             DEFAULT_CHARACTER_SET_NAME AS charset,
             DEFAULT_COLLATION_NAME    AS collation
           FROM information_schema.SCHEMATA
           WHERE SCHEMA_NAME = ?`,
          [r.db],
        );
        sections.push("## Database");
        sections.push(formatAsTable(dbInfo));
        structured.databaseInfo = dbInfo[0] ?? null;

        if (table) {
          // Table-level
          const tableInfo = await queryWithTimeout<
            Array<Record<string, unknown>>
          >(
            connection,
            `SELECT
               TABLE_NAME,
               TABLE_COLLATION AS collation,
               (SELECT CHARACTER_SET_NAME
                FROM information_schema.COLLATIONS
                WHERE COLLATION_NAME = t.TABLE_COLLATION) AS charset
             FROM information_schema.TABLES t
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
            [r.db, table],
          );
          sections.push("\n## Table");
          sections.push(formatAsTable(tableInfo));
          structured.tableInfo = tableInfo[0] ?? null;

          // Column-level — only those that override the table default,
          // i.e. text/string columns with an explicit charset/collation.
          const cols = await queryWithTimeout<Array<Record<string, unknown>>>(
            connection,
            `SELECT
               COLUMN_NAME,
               COLUMN_TYPE,
               CHARACTER_SET_NAME AS charset,
               COLLATION_NAME    AS collation
             FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ?
               AND TABLE_NAME = ?
               AND CHARACTER_SET_NAME IS NOT NULL
             ORDER BY ORDINAL_POSITION`,
            [r.db, table],
          );
          sections.push("\n## Columns (string/text types only)");
          sections.push(formatAsTable(cols));
          structured.columns = cols;
        }

        return toolOk(sections.join("\n"), structured);
      },
    ),
  );
}

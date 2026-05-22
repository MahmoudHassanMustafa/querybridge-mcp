import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWithTimeout } from "../connection.js";
import { qualifiedTable } from "../sql/identifiers.js";
import { resolveDb } from "../db/resolve.js";
import { getTableStats } from "../db/introspection.js";
import { formatAsTable, humanSize } from "../format.js";
import { toolOk, toolHandler, READ_ONLY_TOOL_ANNOTATIONS } from "../tool-runtime.js";

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
        table: z.string().optional().describe("Table name (omit for all tables)"),
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
    toolHandler("sample_data", async ({ connection, table, database, limit }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const qt = qualifiedTable(r.db, table);
      const n = limit ?? 5;

      const data = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        `SELECT * FROM ${qt} LIMIT ?`,
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
    }),
  );
}

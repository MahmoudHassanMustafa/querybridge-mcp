import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../tool-runtime.js";
import {
  handleDescribeTable,
  handleDescribeView,
  handleGetDdl,
  handleGetForeignKeys,
  handleGetIndexes,
  handleGetViewDdl,
  handleListTables,
  handleListViews,
  handleSearchColumns,
} from "./handlers.js";

/**
 * Schema-introspection tools — pure registration. Every handler body
 * lives in `./handlers.ts`; this file is the declarative wiring so
 * the bin (zod schema, title, description, annotations, handler) for
 * each tool is in one place.
 */
export function registerSchemaTools(server: McpServer) {
  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "List all tables in the current (or specified) database with row counts",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z
          .string()
          .optional()
          .describe("Database name (uses connection default if omitted)"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleListTables,
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table (one or many)",
      description:
        "Show the schema of a table: columns, types, keys, indexes, and CREATE statement. " +
        "Two modes:\n" +
        '  • `table: "users"` → flat single-table response (legacy shape).\n' +
        '  • `tables: ["a", "b"]` → multi-table batch in one call, returns `{ results: [...] }`.\n' +
        "Mixing both forms merges and deduplicates.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z
          .string()
          .optional()
          .describe(
            "Single table — keeps the legacy flat response shape. Either `table` or `tables` is required.",
          ),
        tables: z
          .array(z.string())
          .optional()
          .describe(
            "Batch describe: each name returns one entry in `results`. Use this when you want schemas of several tables in one call.",
          ),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleDescribeTable,
  );

  server.registerTool(
    "get_ddl",
    {
      title: "Get table DDL (one or many)",
      description:
        "Get `CREATE TABLE` DDL statements. Two modes:\n" +
        '  • `table: "users"` → flat single-table response (legacy).\n' +
        '  • `tables: ["a", "b"]` → batch, returns `{ results: [{table, ddl}, ...] }`.\n' +
        "Mixing both forms merges and deduplicates.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z
          .string()
          .optional()
          .describe(
            "Single table — keeps the legacy flat response shape. Either `table` or `tables` is required.",
          ),
        tables: z
          .array(z.string())
          .optional()
          .describe(
            "Batch DDL fetch: each name returns one entry in `results`. Use this for schema-dump-style operations.",
          ),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetDdl,
  );

  server.registerTool(
    "get_foreign_keys",
    {
      title: "Get foreign keys (one, some, or all tables)",
      description:
        "Show foreign-key relationships. Three modes: `table` for one table, " +
        "`tables: [...]` for a subset in one call, or omit both for every FK " +
        "in the database. Response shape is the same in all modes (FKs are " +
        "already mixed across tables in the all-mode response).",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z
          .string()
          .optional()
          .describe(
            "Single table to filter to. Omit if using `tables` or to get every FK in the database.",
          ),
        tables: z
          .array(z.string())
          .optional()
          .describe(
            "Filter to FKs whose source is in this list of tables. Omit (or use `table`) for the single-or-all modes.",
          ),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetForeignKeys,
  );

  server.registerTool(
    "get_indexes",
    {
      title: "Get indexes (one, some, or all tables)",
      description:
        "Show indexes for one, some, or all tables in the database, with " +
        "duplicate detection (overlapping leading-column indexes flagged). " +
        "Three modes: `table` for one, `tables: [...]` for a subset, or omit " +
        "both for every index in the database.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z
          .string()
          .optional()
          .describe(
            "Single table to filter to. Omit if using `tables` or to get every index in the database.",
          ),
        tables: z
          .array(z.string())
          .optional()
          .describe(
            "Filter to indexes on this list of tables. Omit (or use `table`) for the single-or-all modes.",
          ),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetIndexes,
  );

  server.registerTool(
    "search_columns",
    {
      title: "Search columns",
      description:
        "Find columns by name pattern across all tables (supports SQL LIKE wildcards: %email%)",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        pattern: z
          .string()
          .describe("Column name pattern (SQL LIKE syntax, e.g. %email%)"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleSearchColumns,
  );

  server.registerTool(
    "list_views",
    {
      title: "List views",
      description: "List all views in the current (or specified) database",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z
          .string()
          .optional()
          .describe("Database name (uses connection default if omitted)"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleListViews,
  );

  server.registerTool(
    "describe_view",
    {
      title: "Describe view",
      description: "Show the columns and CREATE VIEW DDL of a view",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        view: z.string().describe("View name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleDescribeView,
  );

  server.registerTool(
    "get_view_ddl",
    {
      title: "Get view DDL",
      description: "Get the CREATE VIEW DDL statement for a view",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        view: z.string().describe("View name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetViewDdl,
  );
}

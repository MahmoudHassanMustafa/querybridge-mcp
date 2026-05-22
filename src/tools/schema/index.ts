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
      title: "Describe table",
      description: "Show the schema of a table: columns, types, keys, indexes",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z.string().describe("Table name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleDescribeTable,
  );

  server.registerTool(
    "get_ddl",
    {
      title: "Get table DDL",
      description: "Get the CREATE TABLE DDL statement for a table",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z.string().describe("Table name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetDdl,
  );

  server.registerTool(
    "get_foreign_keys",
    {
      title: "Get foreign keys",
      description:
        "Show foreign key relationships for a table or entire database",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z
          .string()
          .optional()
          .describe("Table name (omit for all FKs in database)"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetForeignKeys,
  );

  server.registerTool(
    "get_indexes",
    {
      title: "Get indexes",
      description:
        "Show indexes for a table or entire database, with duplicate detection",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z
          .string()
          .optional()
          .describe("Table name (omit for all indexes in database)"),
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

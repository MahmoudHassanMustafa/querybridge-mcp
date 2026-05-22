import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ_ONLY_TOOL_ANNOTATIONS } from "../../tool-runtime.js";
import {
  handleGetEventDdl,
  handleGetRoutineDdl,
  handleGetTriggerDdl,
  handleListEvents,
  handleListRoutines,
  handleListTriggers,
} from "./handlers.js";

/**
 * Routines/triggers/events tools — pure registration. Handler bodies
 * live in `./handlers.ts`; this file owns only the zod schemas,
 * titles, descriptions, and annotations so the user-facing tool
 * surface is one file per concern.
 */
export function registerRoutinesTools(server: McpServer) {
  server.registerTool(
    "list_routines",
    {
      title: "List routines",
      description: "List stored procedures and/or functions in a database",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().optional().describe("Database name"),
        type: z
          .enum(["PROCEDURE", "FUNCTION", "ALL"])
          .optional()
          .describe("Filter by routine type (default: ALL)"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleListRoutines,
  );

  server.registerTool(
    "get_routine_ddl",
    {
      title: "Get routine DDL",
      description: "Get the full DDL of a stored procedure or function",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        name: z.string().describe("Routine name"),
        database: z.string().optional().describe("Database name"),
        type: z
          .enum(["PROCEDURE", "FUNCTION"])
          .optional()
          .describe("Routine type (auto-detected if omitted)"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetRoutineDdl,
  );

  server.registerTool(
    "list_triggers",
    {
      title: "List triggers",
      description: "List triggers in a database, optionally filtered by table",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z
          .string()
          .optional()
          .describe("Table name (omit for all triggers)"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleListTriggers,
  );

  server.registerTool(
    "get_trigger_ddl",
    {
      title: "Get trigger DDL",
      description: "Get the full DDL of a trigger",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        name: z.string().describe("Trigger name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetTriggerDdl,
  );

  server.registerTool(
    "list_events",
    {
      title: "List events",
      description: "List scheduled events in a database",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleListEvents,
  );

  server.registerTool(
    "get_event_ddl",
    {
      title: "Get event DDL",
      description: "Get the full DDL of a scheduled event",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        name: z.string().describe("Event name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetEventDdl,
  );
}

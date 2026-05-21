import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWithTimeout } from "../connection.js";
import {
  escapeId,
  resolveDb,
  formatAsTable,
  toolOk,
  toolHandler,
} from "../helpers.js";

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerRoutinesTools(server: McpServer) {
  // ── list_routines ─────────────────────────────────────────────────
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
      annotations: READ_ONLY,
    },
    toolHandler("list_routines", async ({ connection, database, type }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;
      const routineType = type ?? "ALL";

      let sql = `
        SELECT
          ROUTINE_NAME,
          ROUTINE_TYPE,
          DTD_IDENTIFIER AS RETURN_TYPE,
          ROUTINE_COMMENT,
          DEFINER,
          CREATED,
          LAST_ALTERED,
          SECURITY_TYPE
        FROM information_schema.ROUTINES
        WHERE ROUTINE_SCHEMA = ?`;

      const params: string[] = [r.db];
      if (routineType !== "ALL") {
        sql += ` AND ROUTINE_TYPE = ?`;
        params.push(routineType);
      }
      sql += ` ORDER BY ROUTINE_TYPE, ROUTINE_NAME`;

      const routines = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        sql,
        params,
      );

      if (routines.length === 0) {
        return toolOk(
          `No ${routineType === "ALL" ? "routines" : routineType.toLowerCase() + "s"} found in ${r.db}`,
          { database: r.db, type: routineType, routines: [] },
        );
      }

      return toolOk(
        formatAsTable(routines) + `\n\n${routines.length} routine(s) in ${r.db}`,
        { database: r.db, type: routineType, routines },
      );
    }),
  );

  // ── get_routine_ddl ───────────────────────────────────────────────
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
      annotations: READ_ONLY,
    },
    toolHandler("get_routine_ddl", async ({ connection, name, database, type }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      let routineType = type;
      if (!routineType) {
        const check = await queryWithTimeout<Array<Record<string, string>>>(
          connection,
          `SELECT ROUTINE_TYPE FROM information_schema.ROUTINES
           WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?`,
          [r.db, name],
        );
        const found = check[0];
        if (!found) {
          return toolOk(`Routine "${name}" not found in ${r.db}`, {
            database: r.db,
            name,
            found: false,
          });
        }
        routineType = found.ROUTINE_TYPE as "PROCEDURE" | "FUNCTION";
      }

      const qualifiedName = `${escapeId(r.db)}.${escapeId(name)}`;
      const rows = await queryWithTimeout<Array<Record<string, string>>>(
        connection,
        `SHOW CREATE ${routineType} ${qualifiedName}`,
      );
      const row = rows[0];
      const ddlKey =
        routineType === "PROCEDURE" ? "Create Procedure" : "Create Function";
      const ddl = row?.[ddlKey] ?? "";

      return toolOk(`-- ${routineType}: ${name}\n${ddl}`, {
        database: r.db,
        name,
        type: routineType,
        ddl,
      });
    }),
  );

  // ── list_triggers ─────────────────────────────────────────────────
  server.registerTool(
    "list_triggers",
    {
      title: "List triggers",
      description: "List triggers in a database, optionally filtered by table",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        table: z.string().optional().describe("Table name (omit for all triggers)"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY,
    },
    toolHandler("list_triggers", async ({ connection, table, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      let sql = `
        SELECT
          TRIGGER_NAME,
          EVENT_MANIPULATION AS EVENT,
          ACTION_TIMING AS TIMING,
          EVENT_OBJECT_TABLE AS TABLE_NAME,
          ACTION_ORIENTATION,
          DEFINER,
          CREATED
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ?`;

      const params: string[] = [r.db];
      if (table) {
        sql += ` AND EVENT_OBJECT_TABLE = ?`;
        params.push(table);
      }
      sql += ` ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION`;

      const triggers = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        sql,
        params,
      );

      if (triggers.length === 0) {
        return toolOk(
          table ? `No triggers on table ${table}` : `No triggers in ${r.db}`,
          { database: r.db, table: table ?? null, triggers: [] },
        );
      }

      return toolOk(
        formatAsTable(triggers) + `\n\n${triggers.length} trigger(s)`,
        { database: r.db, table: table ?? null, triggers },
      );
    }),
  );

  // ── get_trigger_ddl ───────────────────────────────────────────────
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
      annotations: READ_ONLY,
    },
    toolHandler("get_trigger_ddl", async ({ connection, name, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      const qualifiedName = `${escapeId(r.db)}.${escapeId(name)}`;
      const rows = await queryWithTimeout<Array<Record<string, string>>>(
        connection,
        `SHOW CREATE TRIGGER ${qualifiedName}`,
      );
      const row = rows[0];
      const ddl = row?.["SQL Original Statement"] ?? "";

      return toolOk(`-- TRIGGER: ${name}\n${ddl}`, {
        database: r.db,
        name,
        ddl,
      });
    }),
  );

  // ── list_events ───────────────────────────────────────────────────
  server.registerTool(
    "list_events",
    {
      title: "List events",
      description: "List scheduled events in a database",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY,
    },
    toolHandler("list_events", async ({ connection, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      const events = await queryWithTimeout<Array<Record<string, unknown>>>(
        connection,
        `SELECT
          EVENT_NAME,
          EVENT_TYPE,
          INTERVAL_VALUE,
          INTERVAL_FIELD,
          STATUS,
          STARTS,
          ENDS,
          LAST_EXECUTED,
          DEFINER
        FROM information_schema.EVENTS
        WHERE EVENT_SCHEMA = ?
        ORDER BY EVENT_NAME`,
        [r.db],
      );

      if (events.length === 0) {
        return toolOk(`No events in ${r.db}`, { database: r.db, events: [] });
      }

      return toolOk(
        formatAsTable(events) + `\n\n${events.length} event(s)`,
        { database: r.db, events },
      );
    }),
  );

  // ── get_event_ddl ─────────────────────────────────────────────────
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
      annotations: READ_ONLY,
    },
    toolHandler("get_event_ddl", async ({ connection, name, database }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      const qualifiedName = `${escapeId(r.db)}.${escapeId(name)}`;
      const rows = await queryWithTimeout<Array<Record<string, string>>>(
        connection,
        `SHOW CREATE EVENT ${qualifiedName}`,
      );
      const row = rows[0];
      const ddl = row?.["Create Event"] ?? "";

      return toolOk(`-- EVENT: ${name}\n${ddl}`, {
        database: r.db,
        name,
        ddl,
      });
    }),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getConnectionConfig,
  listConnectionNames,
  setActiveDatabase,
} from "../connection.js";
import { databaseExists, listDatabaseNames } from "../db/introspection.js";
import { toolOk, toolError, toolHandler } from "../tool-runtime.js";

// ── Handlers (exported for unit tests) ───────────────────────────

export const handleUseDatabase = toolHandler(
  "use_database",
  async ({
    connection,
    database,
  }: {
    connection: string;
    database: string;
  }) => {
    if (!(await databaseExists(connection, database))) {
      return toolError(`Database "${database}" not found`, {
        code: "DATABASE_NOT_FOUND",
        hint: "Run list_databases on this connection to see what exists.",
        suggestions: [
          {
            tool: "list_databases",
            reason: "enumerate databases visible on this connection",
            args: { connection },
          },
        ],
      });
    }
    setActiveDatabase(connection, database);
    return toolOk(`Switched to database "${database}" on ${connection}`, {
      connection,
      database,
    });
  },
);

// ── Tool registration ────────────────────────────────────────────

export function registerConnectionTools(server: McpServer) {
  server.registerTool(
    "list_connections",
    {
      title: "List MySQL connections",
      description: "List all configured database connections and their status",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    toolHandler("list_connections", async () => {
      const names = listConnectionNames();
      const items = names.map((name) => {
        const cfg = getConnectionConfig(name);
        return {
          name,
          host: cfg.host,
          port: cfg.port,
          database: cfg.database ?? null,
          ssh: cfg.ssh ? { host: cfg.ssh.host, port: cfg.ssh.port } : null,
          ssl: cfg.ssl ? true : false,
          readonly: cfg.readonly !== false,
        };
      });
      const lines = items.map((c) => {
        const db = c.database ? ` (db: ${c.database})` : "";
        const tunnel = c.ssh ? ` [SSH: ${c.ssh.host}]` : "";
        const ssl = c.ssl ? " [SSL]" : "";
        const mode = c.readonly ? " [read-only]" : " [read-write]";
        return `- ${c.name}: ${c.host}:${c.port}${db}${tunnel}${ssl}${mode}`;
      });
      return toolOk(lines.join("\n") || "No connections configured", {
        connections: items,
      });
    }),
  );

  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description: "List all databases on a connection",
      inputSchema: { connection: z.string().describe("Connection name") },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    toolHandler("list_databases", async ({ connection }) => {
      const databases = await listDatabaseNames(connection);
      return toolOk(
        `${databases.join("\n")}\n\n${databases.length} database(s)`,
        { databases },
      );
    }),
  );

  server.registerTool(
    "use_database",
    {
      title: "Set active database",
      description: "Switch the active database/schema for a connection",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().describe("Database name to switch to"),
      },
      annotations: {
        // Mutates server-side connection state, not DB content. Not destructive.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handleUseDatabase,
  );
}

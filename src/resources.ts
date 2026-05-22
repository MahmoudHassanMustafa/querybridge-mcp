import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listConnectionNames,
  getConnectionConfig,
  queryWithTimeout,
} from "./connection.js";
import { qualifiedTable } from "./sql/identifiers.js";
import { formatAsTable } from "./format.js";
import {
  getCreateTable,
  listDatabaseNames,
  listTableNames,
} from "./db/introspection.js";

export function registerResources(server: McpServer) {
  // ── Table schema resource ─────────────────────────────────────────
  server.registerResource(
    "table-schema",
    new ResourceTemplate(
      "mysql://{connection}/{database}/{table}/schema",
      {
        list: async () => {
          const resources: Array<{
            uri: string;
            name: string;
            description: string;
            mimeType: string;
          }> = [];

          for (const connName of listConnectionNames()) {
            const cfg = getConnectionConfig(connName);
            const db = cfg.database;
            if (!db) continue;

            try {
              const tables = await listTableNames(connName, db);
              for (const table of tables) {
                resources.push({
                  uri: `mysql://${connName}/${db}/${table}/schema`,
                  name: `${connName}/${db}/${table}`,
                  description: `Schema for ${table} in ${db}`,
                  mimeType: "text/plain",
                });
              }
            } catch {
              // skip connections that aren't ready
            }
          }
          return { resources };
        },
        complete: {
          connection: async () => listConnectionNames(),
          database: async (value, ctx) => {
            try {
              const args = ctx?.arguments ?? {};
              return await listDatabaseNames(args.connection as string);
            } catch {
              return [];
            }
          },
          table: async (value, ctx) => {
            try {
              const args = ctx?.arguments ?? {};
              return await listTableNames(
                args.connection as string,
                args.database as string,
              );
            } catch {
              return [];
            }
          },
        },
      }
    ),
    {
      title: "Table schema",
      description: "Schema definition for a MySQL table",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const connName = variables.connection as string;
      const db = variables.database as string;
      const table = variables.table as string;
      const qt = qualifiedTable(db, table);

      const columns = await queryWithTimeout(connName, `DESCRIBE ${qt}`);
      const createStatement = await getCreateTable(connName, db, table);

      const text = [
        `# ${db}.${table}`,
        "",
        "## Columns",
        formatAsTable(columns as Record<string, unknown>[]),
        "",
        "## DDL",
        "```sql",
        createStatement,
        "```",
      ].join("\n");

      return {
        contents: [{ uri: uri.toString(), text, mimeType: "text/plain" }],
      };
    }
  );

  // ── Database overview resource ────────────────────────────────────
  server.registerResource(
    "database-overview",
    new ResourceTemplate(
      "mysql://{connection}/{database}/overview",
      {
        list: async () => {
          const resources: Array<{
            uri: string;
            name: string;
            description: string;
            mimeType: string;
          }> = [];

          for (const connName of listConnectionNames()) {
            const cfg = getConnectionConfig(connName);
            const db = cfg.database;
            if (!db) continue;
            resources.push({
              uri: `mysql://${connName}/${db}/overview`,
              name: `${connName}/${db}`,
              description: `Overview of all tables in ${db}`,
              mimeType: "text/plain",
            });
          }
          return { resources };
        },
        complete: {
          connection: async () => listConnectionNames(),
          database: async (value, ctx) => {
            try {
              const args = ctx?.arguments ?? {};
              return await listDatabaseNames(args.connection as string);
            } catch {
              return [];
            }
          },
        },
      }
    ),
    {
      title: "Database overview",
      description: "Overview of all tables in a MySQL database",
      mimeType: "text/plain",
    },
    async (uri, variables) => {
      const connName = variables.connection as string;
      const db = variables.database as string;

      interface DatabaseOverviewRow {
        TABLE_NAME: string;
        TABLE_ROWS: number | null;
        ENGINE: string | null;
        DATA_LENGTH: number | null;
        INDEX_LENGTH: number | null;
      }
      const rows = await queryWithTimeout<DatabaseOverviewRow[]>(
        connName,
        `SELECT TABLE_NAME, TABLE_ROWS, ENGINE, DATA_LENGTH, INDEX_LENGTH
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
        [db]
      );

      const text = [
        `# Database: ${db}`,
        "",
        formatAsTable(rows),
      ].join("\n");

      return {
        contents: [{ uri: uri.toString(), text, mimeType: "text/plain" }],
      };
    }
  );
}

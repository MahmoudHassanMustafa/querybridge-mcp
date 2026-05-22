import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWithTimeout } from "../connection.js";
import { resolveDb } from "../db/resolve.js";
import { toolOk, toolHandler } from "../tool-runtime.js";

export function registerErdTool(server: McpServer) {
  server.registerTool(
    "generate_erd",
    {
      title: "Generate ER diagram",
      description: "Generate a Mermaid ER diagram from the database schema",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().optional().describe("Database name"),
        tables: z
          .array(z.string())
          .optional()
          .describe("Specific tables to include (omit for all tables)"),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    toolHandler("generate_erd", async ({ connection, database, tables }) => {
      const r = resolveDb(connection, database);
      if ("error" in r) return r.error;

      let colSql = `
        SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ?`;
      const colParams: string[] = [r.db];

      if (tables && tables.length > 0) {
        colSql += ` AND TABLE_NAME IN (${tables.map(() => "?").join(",")})`;
        colParams.push(...tables);
      }
      colSql += ` ORDER BY TABLE_NAME, ORDINAL_POSITION`;

      const columns = await queryWithTimeout<
        Array<{
          TABLE_NAME: string;
          COLUMN_NAME: string;
          COLUMN_TYPE: string;
          COLUMN_KEY: string;
        }>
      >(connection, colSql, colParams);

      if (columns.length === 0) {
        return toolOk("No tables found", { database: r.db, mermaid: "" });
      }

      let fkSql = `
        SELECT
          TABLE_NAME,
          COLUMN_NAME,
          REFERENCED_TABLE_NAME,
          REFERENCED_COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL`;
      const fkParams: string[] = [r.db];

      if (tables && tables.length > 0) {
        fkSql += ` AND TABLE_NAME IN (${tables.map(() => "?").join(",")})`;
        fkParams.push(...tables);
      }

      const foreignKeys = await queryWithTimeout<
        Array<{
          TABLE_NAME: string;
          COLUMN_NAME: string;
          REFERENCED_TABLE_NAME: string;
          REFERENCED_COLUMN_NAME: string;
        }>
      >(connection, fkSql, fkParams);

      const fkColSet = new Set(
        foreignKeys.map((fk) => `${fk.TABLE_NAME}.${fk.COLUMN_NAME}`),
      );

      const tableMap = new Map<
        string,
        Array<{ name: string; type: string; key: string }>
      >();
      for (const col of columns) {
        let bucket = tableMap.get(col.TABLE_NAME);
        if (!bucket) {
          bucket = [];
          tableMap.set(col.TABLE_NAME, bucket);
        }
        bucket.push({
          name: col.COLUMN_NAME,
          type: simplifyType(col.COLUMN_TYPE),
          key: col.COLUMN_KEY,
        });
      }

      const lines: string[] = ["erDiagram"];

      for (const [tableName, cols] of tableMap) {
        lines.push(`    ${sanitizeName(tableName)} {`);
        for (const col of cols) {
          const marker =
            col.key === "PRI"
              ? " PK"
              : fkColSet.has(`${tableName}.${col.name}`)
                ? " FK"
                : "";
          lines.push(`        ${col.type} ${sanitizeName(col.name)}${marker}`);
        }
        lines.push(`    }`);
      }

      for (const fk of foreignKeys) {
        if (
          tableMap.has(fk.TABLE_NAME) &&
          tableMap.has(fk.REFERENCED_TABLE_NAME)
        ) {
          lines.push(
            `    ${sanitizeName(fk.REFERENCED_TABLE_NAME)} ||--o{ ${sanitizeName(fk.TABLE_NAME)} : "${fk.COLUMN_NAME}"`,
          );
        }
      }

      const mermaid = lines.join("\n");
      return toolOk("```mermaid\n" + mermaid + "\n```", {
        database: r.db,
        mermaid,
        tableCount: tableMap.size,
        relationshipCount: foreignKeys.filter(
          (fk) =>
            tableMap.has(fk.TABLE_NAME) &&
            tableMap.has(fk.REFERENCED_TABLE_NAME),
        ).length,
      });
    }),
  );
}

function simplifyType(mysqlType: string): string {
  // split() on a non-empty string always yields at least one element;
  // the fallback satisfies noUncheckedIndexedAccess.
  const base = (mysqlType.split("(")[0] ?? mysqlType).toLowerCase();
  const map: Record<string, string> = {
    int: "int",
    bigint: "bigint",
    smallint: "smallint",
    tinyint: "tinyint",
    mediumint: "mediumint",
    decimal: "decimal",
    float: "float",
    double: "double",
    varchar: "varchar",
    char: "char",
    text: "text",
    mediumtext: "text",
    longtext: "text",
    tinytext: "text",
    blob: "blob",
    mediumblob: "blob",
    longblob: "blob",
    datetime: "datetime",
    timestamp: "timestamp",
    date: "date",
    time: "time",
    year: "year",
    json: "json",
    enum: "enum",
    set: "set",
    boolean: "boolean",
    bit: "bit",
  };
  return map[base] ?? base;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

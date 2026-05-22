import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResultSetHeader } from "mysql2/promise";
import { z } from "zod";
import {
  getPool,
  getConnectionConfig,
  getQueryTimeout,
} from "../connection.js";
import { escapeId } from "../sql/identifiers.js";
import {
  isReadOnlyQuery,
  isExplainSafe,
  stripSQLComments,
} from "../sql/readonly.js";
import { formatAsTable } from "../format.js";
import { toolOk, toolError, toolHandler } from "../tool-runtime.js";
import { withCancellableQuery } from "../db/cancel.js";
import { MAX_RESULT_ROWS } from "../limits.js";
import { MalformedExplainOutput, ReadOnlyViolation } from "../errors.js";

export function registerQueryTools(server: McpServer) {
  // ── execute_query ─────────────────────────────────────────────────
  server.registerTool(
    "execute_query",
    {
      title: "Execute SQL query",
      description:
        "Execute a SQL query. Write operations require the connection to be configured with readonly: false.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        query: z.string().describe("SQL query to execute"),
        params: z
          .array(
            z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.null(),
              // Binary blobs as base64. mysql2 expects Buffer for BLOB
              // columns; we decode at the boundary so the wire format
              // stays valid JSON.
              z
                .object({ $binary: z.string() })
                .describe('{"$binary": "<base64>"} for BLOB/BINARY values'),
            ]),
          )
          .optional()
          .describe(
            "Parameterized query values (use ? placeholders in query). " +
              "ISO 8601 strings are passed through to DATETIME/DATE columns. " +
              'For binary data use {"$binary": "<base64>"}.',
          ),
      },
      annotations: {
        // Whether the call mutates depends on the connection's readonly
        // flag — we can't promise either way at registration time, so we
        // conservatively flag potential destructiveness for clients that
        // gate confirmation on it.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    toolHandler("execute_query", async ({ connection, query, params }, extra) => {
      const config = getConnectionConfig(connection);

      if (config.readonly !== false && !isReadOnlyQuery(query)) {
        // Thrown (not returned) so toolHandler sees the typed error and
        // produces a consistent code=READ_ONLY_VIOLATION log line.
        throw new ReadOnlyViolation(connection);
      }

      const pool = getPool(connection);
      const db = config.database;
      const timeout = getQueryTimeout(connection);

      return withCancellableQuery(
        pool,
        { connection, toolName: "execute_query", signal: extra?.signal },
        async (worker) => {
          if (db) {
            await worker.query(`USE ${escapeId(db)}`);
          }

          // Auto-append LIMIT to unbounded SELECT to prevent OOM. Strip a
          // trailing ';' first — appending "LIMIT 1000" after a terminator
          // produces invalid SQL when multipleStatements is off.
          let boundedQuery = query;
          const normalized = stripSQLComments(query);
          if (
            /^\s*SELECT\b/i.test(normalized) &&
            !/\bLIMIT\b/i.test(normalized)
          ) {
            boundedQuery = `${query.replace(/;\s*$/, "")} LIMIT ${MAX_RESULT_ROWS}`;
          }

          const resolvedParams = (params ?? []).map((p) => {
            if (
              p &&
              typeof p === "object" &&
              "$binary" in p &&
              typeof p.$binary === "string"
            ) {
              return Buffer.from(p.$binary, "base64");
            }
            return p;
          });

          const startTime = Date.now();
          const [rows, fields] = await worker.execute(
            { sql: boundedQuery, timeout },
            resolvedParams,
          );
          const elapsed = Date.now() - startTime;

          if (Array.isArray(rows) && rows.length > 0 && fields) {
            const text = [
              formatAsTable(rows as Record<string, unknown>[]),
              "",
              `${(rows as unknown[]).length} row(s) returned in ${elapsed}ms`,
            ].join("\n");
            return toolOk(text, {
              rows,
              rowCount: rows.length,
              elapsedMs: elapsed,
            });
          }

          // Non-SELECT path: mysql2 returns a ResultSetHeader rather than
          // a rows array. The narrowing on the SELECT branch above means
          // the type system can't infer this on its own without help.
          const result = rows as ResultSetHeader;
          const text = [
            `Query executed in ${elapsed}ms`,
            result.affectedRows !== undefined
              ? `Affected rows: ${result.affectedRows}`
              : null,
            result.insertId ? `Insert ID: ${result.insertId}` : null,
            result.changedRows !== undefined
              ? `Changed rows: ${result.changedRows}`
              : null,
          ]
            .filter(Boolean)
            .join("\n");

          return toolOk(text, {
            rows: [],
            rowCount: 0,
            elapsedMs: elapsed,
            affectedRows: result.affectedRows ?? null,
            insertId: result.insertId ?? null,
            changedRows: result.changedRows ?? null,
          });
        },
      );
    }),
  );

  // ── explain_query ─────────────────────────────────────────────────
  server.registerTool(
    "explain_query",
    {
      title: "Explain query plan",
      description: "Run EXPLAIN on a SELECT query to show the execution plan",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        query: z.string().describe("SELECT query to analyze"),
        format: z
          .enum(["TRADITIONAL", "JSON", "TREE"])
          .optional()
          .describe("Output format (default: JSON for richest detail)"),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    toolHandler("explain_query", async ({ connection, query, format }, extra) => {
      if (!isExplainSafe(query)) {
        return toolError(
          "EXPLAIN is restricted to SELECT queries for safety.",
          "Provide a SELECT statement (no write operations, no INTO OUTFILE/DUMPFILE).",
        );
      }

      const pool = getPool(connection);
      const fmt = format ?? "JSON";
      const timeout = getQueryTimeout(connection);
      const db = getConnectionConfig(connection).database;

      return withCancellableQuery(
        pool,
        { connection, toolName: "explain_query", signal: extra?.signal },
        async (worker) => {
          if (db) await worker.query(`USE ${escapeId(db)}`);

          const explainSql =
            fmt === "TRADITIONAL"
              ? `EXPLAIN ${query}`
              : `EXPLAIN FORMAT=${fmt} ${query}`;

          const [rows] = await worker.execute({ sql: explainSql, timeout });
          const resultRows = rows as Array<Record<string, unknown>>;

          if (fmt === "JSON" && resultRows[0]?.EXPLAIN) {
            // MySQL hands us a JSON string; if it ever sends back something
            // malformed we'd rather surface a tool error than crash the handler.
            let parsed: unknown;
            try {
              parsed = JSON.parse(resultRows[0].EXPLAIN as string);
            } catch (err) {
              throw new MalformedExplainOutput(
                err instanceof Error ? err.message : String(err),
              );
            }
            return toolOk(
              "```json\n" + JSON.stringify(parsed, null, 2) + "\n```",
              { format: fmt, plan: parsed as Record<string, unknown> },
            );
          }

          if (fmt === "TREE" && resultRows[0]?.EXPLAIN) {
            return toolOk("```\n" + resultRows[0].EXPLAIN + "\n```", {
              format: fmt,
              tree: resultRows[0].EXPLAIN,
            });
          }

          return toolOk(formatAsTable(resultRows), {
            format: fmt,
            rows: resultRows,
          });
        },
      );
    }),
  );
}

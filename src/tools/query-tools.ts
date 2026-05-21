import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getPool,
  getConnectionConfig,
  getQueryTimeout,
} from "../connection.js";
import {
  escapeId,
  formatAsTable,
  toolOk,
  toolError,
  toolHandler,
  isReadOnlyQuery,
  isExplainSafe,
  stripSQLComments,
  log,
} from "../helpers.js";

const MAX_RESULT_ROWS = 1000;

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
        return toolError(
          `Connection "${connection}" is read-only. Only SELECT, SHOW, DESCRIBE, EXPLAIN, and USE are allowed.`,
          'Set "readonly": false in the connection config to enable writes.',
        );
      }

      const pool = getPool(connection);
      const db = config.database;
      const timeout = getQueryTimeout(connection);

      // Track the worker connection so we can KILL its in-flight query if
      // the MCP client cancels the request (RequestHandlerExtra.signal).
      let conn: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
      let connectionId: number | undefined;
      let killed = false;

      const onAbort = async () => {
        if (connectionId == null) return;
        killed = true;
        // Open a sibling connection — the one running the query is busy.
        try {
          const killer = await pool.getConnection();
          try {
            await killer.query(`KILL QUERY ${connectionId}`);
            log("info", "execute_query cancelled by client", {
              connection,
              connectionId,
            });
          } finally {
            killer.release();
          }
        } catch (err) {
          log("warn", "execute_query KILL failed", {
            connection,
            connectionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      const signal: AbortSignal | undefined = extra?.signal;
      if (signal?.aborted) {
        return toolError("Request was cancelled before execution started.");
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        conn = await pool.getConnection();

        // Capture CONNECTION_ID() so a later KILL QUERY can target this
        // specific session.
        const [idRows] = await conn.query("SELECT CONNECTION_ID() AS id");
        connectionId = (idRows as Array<{ id: number }>)[0]?.id;

        if (db) {
          await conn.query(`USE ${escapeId(db)}`);
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
        const [rows, fields] = await conn.execute(
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

        const result = rows as unknown as Record<string, unknown>;
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
      } catch (err) {
        if (killed) {
          return toolError(
            "Query was cancelled by the client (KILL QUERY issued).",
          );
        }
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        conn?.release();
      }
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

      let conn: Awaited<ReturnType<typeof pool.getConnection>> | undefined;
      let connectionId: number | undefined;
      let killed = false;

      const onAbort = async () => {
        if (connectionId == null) return;
        killed = true;
        try {
          const killer = await pool.getConnection();
          try {
            await killer.query(`KILL QUERY ${connectionId}`);
          } finally {
            killer.release();
          }
        } catch (err) {
          log("warn", "explain_query KILL failed", {
            connection,
            connectionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      const signal: AbortSignal | undefined = extra?.signal;
      if (signal?.aborted) {
        return toolError("Request was cancelled before execution started.");
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        conn = await pool.getConnection();
        const [idRows] = await conn.query("SELECT CONNECTION_ID() AS id");
        connectionId = (idRows as Array<{ id: number }>)[0]?.id;

        if (db) await conn.query(`USE ${escapeId(db)}`);

        const explainSql =
          fmt === "TRADITIONAL"
            ? `EXPLAIN ${query}`
            : `EXPLAIN FORMAT=${fmt} ${query}`;

        const [rows] = await conn.execute({ sql: explainSql, timeout });
        const resultRows = rows as Array<Record<string, unknown>>;

        if (fmt === "JSON" && resultRows[0]?.EXPLAIN) {
          const parsed = JSON.parse(resultRows[0].EXPLAIN as string);
          return toolOk(
            "```json\n" + JSON.stringify(parsed, null, 2) + "\n```",
            { format: fmt, plan: parsed },
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
      } catch (err) {
        if (killed) {
          return toolError(
            "EXPLAIN was cancelled by the client (KILL QUERY issued).",
          );
        }
        throw err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        conn?.release();
      }
    }),
  );
}

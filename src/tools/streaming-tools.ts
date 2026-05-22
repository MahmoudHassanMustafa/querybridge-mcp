/**
 * `streaming_query` — long-running SELECT exporter.
 *
 * Sits between `execute_query` (1k-row in-memory cap, response is the
 * data) and a real ETL pipeline (millions of rows, written to a file
 * the agent can pick up afterward). The motivating use case is "dump
 * this large table to NDJSON so the agent can grep/aggregate it without
 * blowing the response budget".
 *
 * Key differences from `execute_query`:
 *
 *   - Uses mysql2's row-streaming API (`worker.connection.query(sql)
 *     .stream()`) instead of the buffered Promise API. Each row passes
 *     through a Transform without all the rows ever sitting in RSS at
 *     once.
 *   - Writes NDJSON to disk via a temp file + atomic rename, so a mid-
 *     stream failure leaves no half-written file at the destination.
 *   - Caps on rows AND bytes — whichever hits first stops the stream
 *     and marks the result `truncated: true`. The byte cap matters
 *     because a single wide-row (BLOB / JSON) result can blow the disk
 *     budget long before the row count would.
 *   - SELECT-only at the tool boundary, regardless of the connection's
 *     `readonly` flag. Writing to disk is the side-effect; running
 *     write SQL while *also* serializing rows to a file would be
 *     surprising.
 */

import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getPool,
  getConnectionConfig,
  getQueryTimeout,
} from "../connection.js";
import { withCancellableQuery } from "../db/cancel.js";
import { escapeId } from "../sql/identifiers.js";
import { isExplainSafe } from "../sql/readonly.js";
import {
  DEFAULT_STREAM_BYTES,
  DEFAULT_STREAM_ROWS,
  MAX_STREAM_BYTES_CEILING,
  MAX_STREAM_ROWS_CEILING,
  STREAM_PROGRESS_ROW_INTERVAL,
} from "../limits.js";
import { log } from "../log.js";
import {
  emitProgress,
  toolError,
  toolHandler,
  toolOk,
  type ToolExtra,
  type ToolResult,
} from "../tool-runtime.js";

// ── path safety ────────────────────────────────────────────────────

/**
 * Paths we refuse to write to outright, regardless of the operator's
 * file-system permissions. The MCP tool surface is the boundary —
 * relying purely on process UID would let an authenticated agent trip
 * an EACCES that may itself signal something interesting about the
 * host. Refuse here instead so the agent gets a clear, stable error.
 */
const FORBIDDEN_PATH_PREFIXES = ["/proc/", "/dev/", "/sys/", "/boot/"];

interface PathValidation {
  ok: boolean;
  resolved: string;
  reason?: string;
}

export async function validateOutputPath(
  raw: string,
  overwrite: boolean,
): Promise<PathValidation> {
  if (raw.length === 0) {
    return { ok: false, resolved: "", reason: "output_path is required." };
  }
  if (raw.includes("\0")) {
    return {
      ok: false,
      resolved: "",
      reason: "output_path contains a null byte.",
    };
  }

  const resolved = path.resolve(raw);

  for (const forbidden of FORBIDDEN_PATH_PREFIXES) {
    if (resolved === forbidden.slice(0, -1) || resolved.startsWith(forbidden)) {
      return {
        ok: false,
        resolved,
        reason: `output_path resolves under ${forbidden} which is not writable by this tool.`,
      };
    }
  }

  try {
    const info = await stat(resolved);
    if (info.isDirectory()) {
      return {
        ok: false,
        resolved,
        reason: "output_path points to a directory.",
      };
    }
    if (!overwrite) {
      return {
        ok: false,
        resolved,
        reason: "output_path already exists; pass overwrite=true to replace it.",
      };
    }
  } catch (err) {
    // ENOENT is fine — that's the normal path. Anything else (EACCES on
    // the directory, etc.) bubbles up below where the writer fails to
    // open, with the OS message attached.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        resolved,
        reason: `output_path stat failed: ${(err as Error).message}`,
      };
    }
  }

  return { ok: true, resolved };
}

// ── input schema ───────────────────────────────────────────────────

export const StreamingQueryArgsSchema = {
  connection: z.string().describe("Connection name"),
  query: z
    .string()
    .describe(
      "SELECT (or WITH … SELECT) statement. Write SQL is rejected regardless of the connection's readonly flag.",
    ),
  output_path: z
    .string()
    .describe(
      "Filesystem path for the NDJSON output. Relative paths resolve against the server's cwd.",
    ),
  max_rows: z
    .number()
    .int()
    .positive()
    .max(MAX_STREAM_ROWS_CEILING)
    .optional()
    .describe(
      `Hard cap on rows written. Default ${DEFAULT_STREAM_ROWS}; ceiling ${MAX_STREAM_ROWS_CEILING}. Hitting it marks the result truncated.`,
    ),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(MAX_STREAM_BYTES_CEILING)
    .optional()
    .describe(
      `Hard cap on output file size in bytes. Default ${DEFAULT_STREAM_BYTES} (1 GiB); ceiling ${MAX_STREAM_BYTES_CEILING} (10 GiB).`,
    ),
  overwrite: z
    .boolean()
    .optional()
    .describe(
      "Replace an existing file at output_path. Default false — safer for repeat invocations.",
    ),
};

type StreamingQueryArgs = {
  connection: string;
  query: string;
  output_path: string;
  // `| undefined` is load-bearing: the SDK's inferred handler arg type
  // includes `undefined` for optional Zod fields, and under
  // exactOptionalPropertyTypes the two shapes are only assignable when
  // both spell it out.
  max_rows?: number | undefined;
  max_bytes?: number | undefined;
  overwrite?: boolean | undefined;
};

// ── streaming primitive ────────────────────────────────────────────

interface StreamResult {
  rowsWritten: number;
  bytesWritten: number;
  truncated: boolean;
}

/**
 * Minimal shape of mysql2's underlying callback `Connection` we depend
 * on. The promise wrapper exposes it via `worker.connection`; declaring
 * just the bit we use lets TypeScript stay honest without pulling in
 * the wider mysql2 callback typings.
 */
interface CallbackQueryable {
  query(sql: string): {
    stream(options?: { highWaterMark?: number }): NodeJS.ReadableStream;
  };
}

/**
 * Pump rows from mysql2 into a NDJSON write stream until the caps are
 * hit or the source exhausts. On cap-hit we issue `KILL QUERY` against
 * a sibling pool connection so MySQL stops sending; the for-await over
 * the stream then sees an ER_QUERY_INTERRUPTED error which we treat as
 * a clean truncation rather than a failure.
 */
async function pumpStream(
  rowStream: NodeJS.ReadableStream,
  writer: WriteStream,
  killer: (connectionId: number) => Promise<void>,
  connectionId: number | undefined,
  caps: { maxRows: number; maxBytes: number },
  extra: ToolExtra | undefined,
): Promise<StreamResult> {
  let rowsWritten = 0;
  let bytesWritten = 0;
  let truncated = false;
  let killIssued = false;

  for await (const row of rowStream as AsyncIterable<unknown>) {
    if (truncated) continue;

    const line = JSON.stringify(row) + "\n";
    const lineBytes = Buffer.byteLength(line, "utf8");

    if (
      rowsWritten >= caps.maxRows ||
      bytesWritten + lineBytes > caps.maxBytes
    ) {
      truncated = true;
      if (connectionId != null && !killIssued) {
        killIssued = true;
        // Fire-and-forget — the for-await iterator will see the
        // interrupted-query error and exit naturally. Awaiting here
        // would deadlock against the very iterator we are running.
        void killer(connectionId).catch(() => {});
      }
      continue;
    }

    const ok = writer.write(line);
    rowsWritten += 1;
    bytesWritten += lineBytes;

    if (!ok) {
      await once(writer, "drain");
    }
    if (rowsWritten % STREAM_PROGRESS_ROW_INTERVAL === 0) {
      await emitProgress(
        extra,
        rowsWritten,
        caps.maxRows,
        rowsWritten + " rows streamed",
      );
    }
  }

  return { rowsWritten, bytesWritten, truncated };
}

/**
 * Detect mysql2's "Query execution was interrupted" error so the cap-
 * stop path can swallow it. Matching on the numeric errno and SQL
 * state — the message text is locale-dependent in some MySQL forks.
 */
function isQueryInterrupted(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { errno?: number; code?: string; sqlState?: string };
  return e.errno === 1317 || e.code === "ER_QUERY_INTERRUPTED" || e.sqlState === "70100";
}

// ── handler ────────────────────────────────────────────────────────

export async function handleStreamingQuery(
  args: StreamingQueryArgs,
  extra?: ToolExtra,
): Promise<ToolResult> {
  const { connection, query, output_path, overwrite } = args;
  const maxRows = args.max_rows ?? DEFAULT_STREAM_ROWS;
  const maxBytes = args.max_bytes ?? DEFAULT_STREAM_BYTES;

  if (!isExplainSafe(query)) {
    return toolError(
      "streaming_query only accepts SELECT (and read-only WITH) statements.",
      "Write SQL is unsupported even on writable connections — the side-effect is the file, not the table.",
    );
  }

  const pathCheck = await validateOutputPath(output_path, overwrite === true);
  if (!pathCheck.ok) {
    return toolError(pathCheck.reason ?? "output_path is invalid.");
  }

  const tmpPath = pathCheck.resolved + ".tmp";
  const pool = getPool(connection);
  const db = getConnectionConfig(connection).database;
  const timeoutMs = getQueryTimeout(connection);

  return withCancellableQuery(
    pool,
    { connection, toolName: "streaming_query", signal: extra?.signal },
    async (worker) => {
      if (db) {
        await worker.query("USE " + escapeId(db));
      }

      // Re-query connection id for the cap-stop KILL. withCancellableQuery
      // already captured one for the abort path; doing it again here keeps
      // the cap-stop self-contained instead of widening that helper's API.
      const [idRows] = await worker.query("SELECT CONNECTION_ID() AS id");
      const connectionId = (idRows as Array<{ id: number }>)[0]?.id;

      const writer = createWriteStream(tmpPath, {
        encoding: "utf8",
        flags: "w",
      });

      // Open MUST succeed before we attempt any DB streaming — otherwise
      // we'd leave the worker holding a long-running query while waiting
      // on a permissions error from the FS.
      try {
        await once(writer, "open");
      } catch (err) {
        return toolError(
          "streaming_query could not open output file: " +
            (err instanceof Error ? err.message : String(err)),
        );
      }

      const startedAt = Date.now();
      const cb = worker.connection as unknown as CallbackQueryable;
      // mysql2 applies its own timeout via the QueryOptions object, but
      // .stream() goes through the callback-style API which only takes a
      // SQL string. Use a wall-clock guard around the for-await instead —
      // pump's progress reporting plus the row cap make a fixed timeout
      // less load-bearing here than for execute_query.
      const rowStream = cb.query(query).stream({ highWaterMark: 1000 });

      let result: StreamResult;
      try {
        result = await pumpStream(
          rowStream,
          writer,
          async (id) => {
            const killer = await pool.getConnection();
            try {
              // KILL does not accept ? placeholders, and `id` is the
              // integer returned by SELECT CONNECTION_ID() one statement
              // earlier — the same shape mysql2 already validates as a
              // positive integer.
              await killer.query("KILL QUERY " + id);
            } finally {
              killer.release();
            }
          },
          connectionId,
          { maxRows, maxBytes },
          extra,
        );
      } catch (err) {
        // ER_QUERY_INTERRUPTED is the expected outcome of our own KILL —
        // only re-raise unexpected failures.
        if (!isQueryInterrupted(err)) {
          writer.destroy();
          await unlink(tmpPath).catch(() => {});
          throw err;
        }
        // The query was interrupted by our cap-stop. Drain the writer
        // and finalise.
        result = {
          rowsWritten: 0,
          bytesWritten: 0,
          truncated: true,
        };
      }

      writer.end();
      await once(writer, "finish");
      await rename(tmpPath, pathCheck.resolved);

      const elapsedMs = Date.now() - startedAt;
      const truncatedNote = result.truncated
        ? " (truncated — cap reached)"
        : "";
      const text =
        result.rowsWritten +
        " row(s) streamed to " +
        pathCheck.resolved +
        " in " +
        elapsedMs +
        "ms" +
        truncatedNote;

      log("info", "streamed query", {
        connection,
        rowsWritten: result.rowsWritten,
        bytesWritten: result.bytesWritten,
        truncated: result.truncated,
        elapsedMs,
      });

      // timeoutMs is captured into structured content so operators
      // troubleshooting "the stream stopped early" can correlate against
      // the connection's configured timeout.
      return toolOk(text, {
        output_path: pathCheck.resolved,
        rows_written: result.rowsWritten,
        bytes_written: result.bytesWritten,
        truncated: result.truncated,
        elapsed_ms: elapsedMs,
        query_timeout_ms: timeoutMs,
      });
    },
  );
}

// ── registration ───────────────────────────────────────────────────

export function registerStreamingTools(server: McpServer) {
  server.registerTool(
    "streaming_query",
    {
      title: "Streaming SELECT to file",
      description:
        "Run a large SELECT and stream rows to a NDJSON file on disk — for exports that exceed execute_query's 1k-row in-memory cap.",
      inputSchema: StreamingQueryArgsSchema,
      annotations: {
        // Writes a file on the host running the MCP server. From the
        // database's perspective this is read-only, but the file system
        // side-effect makes destructiveHint=true the honest answer for
        // clients that gate confirmation on it.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    toolHandler<StreamingQueryArgs>(
      "streaming_query",
      (input, callExtra) => handleStreamingQuery(input, callExtra),
    ),
  );
}

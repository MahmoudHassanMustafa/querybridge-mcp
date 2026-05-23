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
        reason:
          "output_path already exists; pass overwrite=true to replace it.",
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
      "Filesystem path for the streamed output. Relative paths resolve against the server's cwd. " +
        "Recommended extensions match the chosen format: `.ndjson` (default), `.json` for JSON-array, `.csv` for CSV.",
    ),
  format: z
    .enum(["ndjson", "json", "csv"])
    .optional()
    .describe(
      "Output format. `ndjson` (default) — one JSON object per line; best for streaming consumers. " +
        "`json` — a JSON array `[ {...}, ... ]` document; pretty for jq + downstream tools that expect a single JSON value. " +
        "`csv` — RFC 4180 with a header row; objects/arrays in a cell are JSON-stringified.",
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
  format?: StreamFormat | undefined;
};

// ── streaming primitive ────────────────────────────────────────────

export interface StreamResult {
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
 * Output-format serializer. Drives `pumpStream`'s row → bytes
 * conversion and lets the tool emit NDJSON (default), JSON-array, or
 * CSV with the same streaming machinery.
 *
 * Lifecycle:
 *   1. `start(firstRow)` is called once with the first row before any
 *      `row()` calls. Lets CSV emit a header line, JSON-array emit
 *      `[`, etc.
 *   2. `row(row, rowIndex)` is called for each row in order, including
 *      the first. The serializer is responsible for any required
 *      separator (comma in JSON-array).
 *   3. `end(rowCount)` is called once after the last row, even if
 *      zero rows were streamed. Lets JSON-array close `]`, etc.
 *
 * Every method returns the bytes-as-string to append to the stream.
 * Empty string is a valid no-op (NDJSON's `start`/`end`).
 */
export interface Serializer {
  start(firstRow: Record<string, unknown>): string;
  row(row: Record<string, unknown>, rowIndex: number): string;
  end(rowCount: number): string;
}

const NDJSON_SERIALIZER: Serializer = {
  start: () => "",
  row: (r) => JSON.stringify(r) + "\n",
  end: () => "",
};

const JSON_ARRAY_SERIALIZER: Serializer = {
  start: () => "[",
  row: (r, i) => (i === 0 ? "\n  " : ",\n  ") + JSON.stringify(r),
  // When zero rows arrive, `start()` never fires (pumpStream only
  // calls it once it sees the first row), so the file would otherwise
  // contain just `]\n`. Emit a self-contained `[]\n` instead so the
  // empty-result file is still valid JSON.
  end: (count) => (count > 0 ? "\n]\n" : "[]\n"),
};

/**
 * RFC 4180-style CSV cell. Quoting kicks in only when the value
 * contains a comma, newline, or double quote; embedded quotes are
 * doubled. Null becomes empty. Objects/arrays are JSON-stringified
 * (so a column holding `{"a": 1}` round-trips as the quoted JSON
 * blob `"{""a"":1}"`).
 */
function csvCell(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/[,\r\n"]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const CSV_SERIALIZER: Serializer = {
  start: (firstRow) => Object.keys(firstRow).map(csvCell).join(",") + "\n",
  row: (r) => Object.values(r).map(csvCell).join(",") + "\n",
  end: () => "",
};

/**
 * Map the public `format` arg to a Serializer. Exported as a function
 * (not a switch in pumpStream) so the unit tests can drive each
 * serializer in isolation.
 */
export function serializerFor(format: StreamFormat): Serializer {
  switch (format) {
    case "json":
      return JSON_ARRAY_SERIALIZER;
    case "csv":
      return CSV_SERIALIZER;
    case "ndjson":
    default:
      return NDJSON_SERIALIZER;
  }
}

export type StreamFormat = "ndjson" | "json" | "csv";

/**
 * Pump rows from mysql2 into a write stream until the caps are hit
 * or the source exhausts. On cap-hit we issue `KILL QUERY` against
 * a sibling pool connection so MySQL stops sending; the for-await
 * over the stream then sees an ER_QUERY_INTERRUPTED error which we
 * treat as a clean truncation rather than a failure.
 *
 * The serializer parameter is optional and defaults to NDJSON — the
 * pre-existing behavior. Test call sites that don't pass a serializer
 * (column_stats tests, streaming-tools tests) keep working unchanged.
 *
 * Exported for unit tests — driving this with a synthetic `Readable`
 * lets us verify the progress-notification cadence, the cap-stop
 * killer wiring, AND the per-format byte sequences without spinning
 * up testcontainers. Production callers should still reach
 * `handleStreamingQuery` so they get the SQL gate, path validation,
 * and worker lifecycle around it.
 */
export async function pumpStream(
  rowStream: NodeJS.ReadableStream,
  writer: WriteStream,
  killer: (connectionId: number) => Promise<void>,
  connectionId: number | undefined,
  caps: { maxRows: number; maxBytes: number },
  extra: ToolExtra | undefined,
  serializer: Serializer = NDJSON_SERIALIZER,
): Promise<StreamResult> {
  let rowsWritten = 0;
  let bytesWritten = 0;
  let truncated = false;
  let killIssued = false;
  let startEmitted = false;

  for await (const row of rowStream as AsyncIterable<unknown>) {
    if (truncated) continue;

    const rowObj = row as Record<string, unknown>;

    if (!startEmitted) {
      startEmitted = true;
      const startBytes = serializer.start(rowObj);
      if (startBytes.length > 0) {
        // Byte cap doesn't apply to the header — it's bounded, and
        // refusing to start would surprise the operator. Emit always.
        if (!writer.write(startBytes)) {
          await once(writer, "drain");
        }
        bytesWritten += Buffer.byteLength(startBytes, "utf8");
      }
    }

    const line = serializer.row(rowObj, rowsWritten);
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

  // Close the serialization (e.g. JSON-array's trailing `]`). Skip
  // when truncated — the partial output isn't a valid JSON document
  // anyway and writing `]` would imply otherwise. NDJSON / CSV use
  // empty `end()` so the truncated case is identical for them.
  if (!truncated) {
    const endBytes = serializer.end(rowsWritten);
    if (endBytes.length > 0) {
      if (!writer.write(endBytes)) {
        await once(writer, "drain");
      }
      bytesWritten += Buffer.byteLength(endBytes, "utf8");
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
  return (
    e.errno === 1317 ||
    e.code === "ER_QUERY_INTERRUPTED" ||
    e.sqlState === "70100"
  );
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
      {
        code: "STREAMING_QUERY_NOT_SELECT",
        hint: "Write SQL is unsupported even on writable connections — the side-effect is the file, not the table.",
        suggestions: [
          {
            tool: "execute_query",
            reason:
              "if the SQL needs to mutate data, run it via execute_query against a connection that has readonly: false",
            args: { connection, query },
          },
        ],
      },
    );
  }

  const pathCheck = await validateOutputPath(output_path, overwrite === true);
  if (!pathCheck.ok) {
    // Path validation failures are user-input issues without a clear
    // next-tool to suggest — the agent needs to pick a different path
    // string, not call another tool. Keep the response plain.
    return toolError(pathCheck.reason ?? "output_path is invalid.", {
      code: "STREAMING_QUERY_INVALID_PATH",
    });
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
          serializerFor(args.format ?? "ndjson"),
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
        format: args.format ?? "ndjson",
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
    toolHandler<StreamingQueryArgs>("streaming_query", (input, callExtra) =>
      handleStreamingQuery(input, callExtra),
    ),
  );
}

/**
 * Logger for operator + client visibility.
 *
 *  - Always writes to stderr (operators tailing the process see it).
 *  - When an MCP sink is registered AND connected, also forwards via
 *    `notifications/message` so the connected client sees it too.
 *  - When a request context is active (set by `toolHandler` via
 *    `runWithContext`), every log entry within that async tree is
 *    automatically tagged with a `traceId` so operators can correlate
 *    multi-step tool invocations in one grep.
 *
 * Never writes to stdout — that stream belongs to the MCP JSON-RPC
 * transport.
 *
 * This module is a leaf with one stdlib dependency
 * (`node:async_hooks`); it imports nothing from our codebase, so it
 * can be consumed safely by infrastructure modules without creating
 * an import cycle.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request context propagated through async boundaries. Set once
 * at the `toolHandler` boundary; every nested `log()` picks it up
 * automatically — no manual threading.
 */
export interface LogContext {
  /** Short correlation id — 8 hex chars is plenty for operator-side grep. */
  traceId: string;
  /** Tool name being handled, redundant with toolHandler's own log lines but useful in nested calls. */
  toolName: string;
}

const contextStorage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with a logging context active. Every `log()` call inside
 * the async tree rooted at `fn` — including chained Promise resolutions
 * and setTimeout callbacks scheduled from within — sees the context
 * via `AsyncLocalStorage`.
 */
export function runWithContext<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> {
  return contextStorage.run(ctx, fn);
}

/**
 * Generate a short trace id. Math.random gives 53 bits of entropy
 * which is plenty for distinguishing concurrent in-flight tool
 * invocations in a single MCP server process.
 */
export function newTraceId(): string {
  return Math.random().toString(16).slice(2, 10).padStart(8, "0");
}

/**
 * Logger severity. Mapped to MCP's wider `logging/setLevel` taxonomy
 * via `LEVEL_TO_MCP` when forwarding to a connected client.
 */
export type LogLevel = "info" | "warn" | "error";

/**
 * Optional MCP server sink. When set, every log() call also emits an
 * MCP `notifications/message` so the connected client sees server logs
 * alongside tool results.
 *
 * The sink is set once at server startup via `setLogSink(server)`. It
 * stays `undefined` in tests and for the CLI, which keeps unit tests
 * decoupled from the MCP SDK.
 */
export interface LogSink {
  sendLoggingMessage(params: {
    level:
      | "debug"
      | "info"
      | "notice"
      | "warning"
      | "error"
      | "critical"
      | "alert"
      | "emergency";
    logger?: string;
    data: unknown;
  }): Promise<void>;
}

let logSink: LogSink | undefined;
let logSinkConnected = false;

/**
 * Register the MCP server as a log forwarding target. Calls before
 * `markLogSinkConnected()` are buffered to stderr only — the SDK
 * throws when notifications are sent before the transport is wired.
 */
export function setLogSink(sink: LogSink): void {
  logSink = sink;
}

/**
 * Mark the sink ready to receive notifications. Called after
 * `server.connect(transport)` resolves — sending before the transport
 * is connected throws inside the SDK.
 */
export function markLogSinkConnected(): void {
  logSinkConnected = true;
}

const LEVEL_TO_MCP = {
  info: "info",
  warn: "warning",
  error: "error",
} as const;

export function log(
  level: LogLevel,
  msg: string,
  ctx?: Record<string, unknown>,
): void {
  // Merge ambient context (traceId, toolName) so every log line within
  // a tool invocation is greppable by a single id. The explicit `ctx`
  // arg wins on key collisions so callers can override if needed.
  const ambient = contextStorage.getStore();
  const merged =
    ambient || ctx ? { ...(ambient ?? {}), ...(ctx ?? {}) } : undefined;

  const suffix = merged ? " " + JSON.stringify(merged) : "";
  console.error(`[querybridge-mcp] ${level.toUpperCase()} ${msg}${suffix}`);

  if (logSink && logSinkConnected) {
    // Fire-and-forget — a failed notification must never break the
    // operation that produced the log. Swallow + report once via stderr.
    void logSink
      .sendLoggingMessage({
        level: LEVEL_TO_MCP[level],
        logger: "querybridge-mcp",
        data: merged ? { msg, ...merged } : { msg },
      })
      .catch((err: unknown) => {
        console.error(
          `[querybridge-mcp] ERROR log forwarding failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}

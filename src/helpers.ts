import { homedir } from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";
import { getConnectionConfig } from "./connection.js";

// ── Path utilities ──────────────────────────────────────────────────

export function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", homedir());
  }
  return p;
}

// ── SQL identifier escaping ─────────────────────────────────────────

export function escapeId(name: string): string {
  if (name.length === 0) {
    throw new Error("Identifier cannot be empty");
  }
  if (name.length > 64) {
    throw new Error(
      `Identifier too long (max 64 chars): "${name.substring(0, 20)}..."`,
    );
  }
  if (name.includes("\0")) {
    throw new Error("Identifier cannot contain NUL bytes");
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

export function qualifiedTable(db: string, table: string): string {
  return `${escapeId(db)}.${escapeId(table)}`;
}

// ── Database resolution ─────────────────────────────────────────────

export function resolveDb(
  connection: string,
  database?: string,
): { db: string } | { error: ReturnType<typeof toolError> } {
  const db = database || getConnectionConfig(connection).database;
  if (!db) {
    return {
      error: toolError(
        "No database selected.",
        "Specify a database parameter or use use_database first.",
      ),
    };
  }
  return { db };
}

// ── Logging ─────────────────────────────────────────────────────────

type LogLevel = "info" | "warn" | "error";

/**
 * Optional MCP server sink. When set, every log() call also emits an
 * MCP `notifications/message` so the connected client sees server logs
 * alongside tool results. Stderr output happens regardless — operators
 * tailing logs and the client both get the line.
 *
 * The sink is set once at server startup via `setLogSink(server)`. It
 * stays `undefined` in tests and for the CLI, which keeps unit tests
 * decoupled from the MCP SDK.
 */
interface LogSink {
  sendLoggingMessage(params: {
    level: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";
    logger?: string;
    data: unknown;
  }): Promise<void>;
}

let logSink: LogSink | undefined;
let logSinkConnected = false;

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

/**
 * Logger for operator + client visibility.
 *  - Always writes to stderr (operators tailing the process see it).
 *  - When an MCP sink is registered AND connected, also forwards via
 *    `notifications/message` so the connected client sees it too.
 * Never writes to stdout — that stream belongs to the MCP JSON-RPC transport.
 */
export function log(
  level: LogLevel,
  msg: string,
  ctx?: Record<string, unknown>,
): void {
  const suffix = ctx ? " " + JSON.stringify(ctx) : "";
  console.error(`[querybridge-mcp] ${level.toUpperCase()} ${msg}${suffix}`);

  if (logSink && logSinkConnected) {
    // Fire-and-forget — a failed notification must never break the
    // operation that produced the log. Swallow + report once via stderr.
    void logSink
      .sendLoggingMessage({
        level: LEVEL_TO_MCP[level],
        logger: "querybridge-mcp",
        data: ctx ? { msg, ...ctx } : { msg },
      })
      .catch((err: unknown) => {
        console.error(
          `[querybridge-mcp] ERROR log forwarding failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }
}

// ── SSH host key verification ───────────────────────────────────────

/**
 * Build an ssh2 hostVerifier callback that enforces the given SHA256
 * fingerprint. Returns undefined when no fingerprint is configured —
 * callers should treat undefined as "no verification, warn the operator".
 *
 * Expected input format is what `ssh-keygen -lf <pubkey>` produces:
 *   "SHA256:abc123...base64..."
 * The "SHA256:" prefix is optional; trailing "=" padding is tolerated
 * on either side.
 */
export function buildHostVerifier(
  expected: string | undefined,
): ((key: Buffer) => boolean) | undefined {
  if (!expected) return undefined;
  // Normalize: strip optional "SHA256:" prefix and any base64 padding
  const normalized = expected
    .replace(/^SHA256:/i, "")
    .replace(/=+$/, "")
    .trim();
  return (key: Buffer) => {
    const actual = createHash("sha256")
      .update(key)
      .digest("base64")
      .replace(/=+$/, "");
    const a = Buffer.from(actual);
    const b = Buffer.from(normalized);
    // timingSafeEqual requires equal-length buffers. Length mismatch is
    // a hard reject — it means the fingerprint format is wrong or the
    // server key is different.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  };
}

// ── Error sanitization ──────────────────────────────────────────────

/**
 * Strip internal IPs, usernames, and hostnames from MySQL error messages
 * before they're returned to the MCP client (and thus to the LLM).
 * Operator-side logs should use the raw message, not this.
 */
export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/'[^']*'@'[^']*'/g, "'***'@'***'") // user@host patterns
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "***"); // IPv4
}

// ── Tool response helpers ───────────────────────────────────────────

/**
 * Wrap a tool response with optional structured content. Clients that
 * understand the 2024-11 MCP spec (`structuredContent`) render rich
 * tables/JSON; older ones fall back to the formatted text.
 */
export function toolOk(
  text: string,
  structuredContent?: Record<string, unknown>,
) {
  const result: {
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
  } = { content: [{ type: "text" as const, text }] };
  if (structuredContent !== undefined) {
    result.structuredContent = structuredContent;
  }
  return result;
}

export function toolError(message: string, hint?: string) {
  const parts = [message];
  if (hint) parts.push(`Hint: ${hint}`);
  return {
    content: [{ type: "text" as const, text: parts.join("\n") }],
    isError: true as const,
  };
}

type ToolResult = ReturnType<typeof toolOk> | ReturnType<typeof toolError>;

/**
 * Wrap a tool handler with uniform error handling:
 *   - log the raw error to stderr with tool name + connection context
 *   - return a sanitized toolError to the client
 *
 * Without this, any throw in a tool handler propagates to the MCP SDK
 * with the original MySQL message — which can include 'user'@'host' and
 * internal IPs. Wrap every handler that touches the database.
 */
/**
 * Minimal subset of MCP's RequestHandlerExtra we actually consume. Kept
 * as a structural type so we don't import the SDK into this module — and
 * marked partial so callers can ignore it.
 */
export interface ToolExtra {
  signal?: AbortSignal;
  /**
   * The original request's _meta; carries progressToken when the client
   * opted in. Property values are explicitly `| undefined` to satisfy
   * exactOptionalPropertyTypes when the SDK passes its own RequestMeta
   * shape through.
   */
  _meta?: {
    progressToken?: string | number | undefined;
  } & Record<string, unknown>;
  /**
   * Send a notification (e.g. notifications/progress) back to the client
   * mid-call. The parameter is typed as `any` because the SDK's
   * concrete signature is a narrow discriminated union of ServerNotification
   * shapes that we don't want to mirror in this structural type.
   * Construction happens in emitProgress() — that's the single trusted
   * call site.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification?: (notification: any) => Promise<void>;
}

/**
 * Emit a progress notification if the client opted in by passing a
 * progressToken with the request. No-ops otherwise — clients that didn't
 * ask won't be spammed and we won't fail when the SDK plumbing is absent
 * (e.g. in tests).
 */
export async function emitProgress(
  extra: ToolExtra | undefined,
  progress: number,
  total: number,
  message?: string,
): Promise<void> {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, ...(message ? { message } : {}) },
    });
  } catch {
    // Progress notifications are best-effort; never break the call over one.
  }
}

export function toolHandler<A extends Record<string, unknown>>(
  toolName: string,
  fn: (args: A, extra?: ToolExtra) => Promise<ToolResult>,
): (args: A, extra?: ToolExtra) => Promise<ToolResult> {
  return async (args: A, extra?: ToolExtra) => {
    const start = Date.now();
    const connection =
      typeof args?.connection === "string" ? args.connection : undefined;
    try {
      const result = await fn(args, extra);
      // Audit log every successful invocation so operators can see what
      // the LLM is actually doing against their DBs. isError-bearing
      // results from preconditions (e.g. readonly violation) are logged
      // as 'warn' to make them grep-able.
      const isResultError = "isError" in result && result.isError === true;
      log(isResultError ? "warn" : "info", `${toolName}`, {
        connection,
        elapsedMs: Date.now() - start,
        ...(isResultError ? { rejected: true } : {}),
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("warn", `${toolName} failed`, {
        connection,
        elapsedMs: Date.now() - start,
        error: msg,
      });
      return toolError(`${toolName} failed: ${sanitizeErrorMessage(msg)}`);
    }
  };
}

// ── Table formatting ────────────────────────────────────────────────

// 120 balances readability against information loss for long values
// (URLs, JSON, view bodies, error messages). The byte cap below still
// bounds total output, so loosening the per-cell cap is safe.
const MAX_COL_WIDTH = 120;
// Hard cap on total formatted output. 500 wide rows with TEXT/JSON/BLOB
// columns can run into the multi-MB range, which has been observed to
// provoke 500-class errors from the Anthropic API rather than a clean
// context-size refusal. 256KB is well under any practical token budget
// while still returning meaningful tables.
const MAX_OUTPUT_BYTES = 256 * 1024;

export function formatAsTable(
  rows: Record<string, unknown>[],
  opts?: { maxWidth?: number; maxBytes?: number },
): string {
  const firstRow = rows[0];
  if (firstRow === undefined) return "(empty)";

  const maxW = opts?.maxWidth ?? MAX_COL_WIDTH;
  const maxBytes = opts?.maxBytes ?? MAX_OUTPUT_BYTES;
  const keys = Object.keys(firstRow);

  const truncate = (val: unknown): string => {
    if (val == null) return "NULL";
    let s: string;
    // BLOB / BINARY columns come back as Buffer (Uint8Array). Rendering
    // them as raw bytes either pollutes the output with garbage UTF-8
    // or balloons the payload. Show size-only metadata.
    if (val instanceof Uint8Array) {
      s = `<Buffer ${val.length} bytes>`;
    } else if (typeof val === "object" && !(val instanceof Date)) {
      // mysql2 returns JSON columns as parsed objects/arrays; String(obj)
      // gives "[object Object]". JSON.stringify preserves structure.
      try {
        s = JSON.stringify(val);
      } catch {
        s = String(val);
      }
    } else {
      s = String(val);
    }
    if (s.length <= maxW) return s;
    return s.slice(0, maxW - 3) + "...";
  };

  const widths = keys.map((k) =>
    Math.min(
      maxW,
      Math.max(k.length, ...rows.map((r) => truncate(r[k]).length)),
    ),
  );

  const header = keys.map((k, i) => k.padEnd(widths[i] ?? 0)).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  // Build rows incrementally and stop once we'd exceed the byte budget.
  // Prevents any single over-wide table from tanking the upstream request.
  const body: string[] = [];
  let bytesUsed =
    Buffer.byteLength(header, "utf8") +
    1 +
    Buffer.byteLength(separator, "utf8") +
    1;
  let omitted = 0;
  for (const row of rows) {
    const line = keys
      .map((k, i) => truncate(row[k]).padEnd(widths[i] ?? 0))
      .join(" | ");
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytesUsed + lineBytes > maxBytes) {
      omitted = rows.length - body.length;
      break;
    }
    body.push(line);
    bytesUsed += lineBytes;
  }

  const out = [header, separator, ...body].join("\n");
  if (omitted > 0) {
    return (
      out +
      `\n... (truncated — ${omitted} more row(s) omitted to keep output under ${Math.floor(maxBytes / 1024)}KB)`
    );
  }
  return out;
}

// ── Human-readable sizes ────────────────────────────────────────────

export function humanSize(bytes: number | null | undefined): string {
  if (bytes == null) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Read-only query safety ───────────────────────────────────────────

/**
 * Strip SQL comments so they can't be used to bypass read-only checks.
 * Handles block comments, line comments (-- and #).
 */
export function stripSQLComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " ") // -- line comments
    .replace(/#[^\n]*/g, " ") // # line comments
    .trim();
}

/**
 * Keywords that indicate a write/mutating operation.
 * Used to reject dangerous queries even when they start with an allowed keyword.
 */
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|RENAME|GRANT|REVOKE|LOCK|UNLOCK|CALL|SET|LOAD|DO|HANDLER|IMPORT|INSTALL|UNINSTALL|RESET|PURGE|PREPARE|EXECUTE|DEALLOCATE)\b/i;

/**
 * Block SELECT INTO OUTFILE/DUMPFILE — these are SELECTs that write files
 * to the server filesystem.
 */
const INTO_FILE_PATTERN = /\bINTO\s+(OUTFILE|DUMPFILE)\b/i;

/**
 * Whitelist approach: only allow known safe read-only statements.
 * Returns true if the query is safe for read-only connections.
 *
 * Rules:
 * - SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, USE are allowed
 * - SELECT INTO OUTFILE/DUMPFILE is blocked (writes files)
 * - WITH queries are allowed ONLY if they contain no write keywords
 *   (blocks WITH...INSERT, WITH...UPDATE, WITH...DELETE, etc.)
 */
export function isReadOnlyQuery(sql: string): boolean {
  const normalized = stripSQLComments(sql);

  // Block SELECT INTO OUTFILE/DUMPFILE regardless of context
  if (INTO_FILE_PATTERN.test(normalized)) {
    return false;
  }

  // Simple read-only statements
  if (/^(SHOW|DESCRIBE|DESC|EXPLAIN|USE)\b/i.test(normalized)) {
    return true;
  }

  // SELECT: allowed as long as it doesn't write files (already checked above)
  if (/^SELECT\b/i.test(normalized)) {
    return true;
  }

  // WITH ... SELECT: must not contain any write keywords anywhere in the query.
  // This blocks: WITH cte AS (SELECT 1) INSERT INTO ...
  // False positive edge case: WITH cte AS (SELECT * FROM t WHERE col = 'DELETE')
  //   -> user can use parameterized queries to avoid: WHERE col = ? with param 'DELETE'
  if (/^WITH\b/i.test(normalized)) {
    return !WRITE_KEYWORDS.test(normalized);
  }

  // Everything else is blocked
  return false;
}

/**
 * Validate that a query is safe for EXPLAIN (SELECT only, no write side-effects).
 */
export function isExplainSafe(sql: string): boolean {
  const normalized = stripSQLComments(sql);

  if (INTO_FILE_PATTERN.test(normalized)) {
    return false;
  }

  // Only allow plain SELECT or WITH...SELECT (no write keywords)
  if (/^SELECT\b/i.test(normalized)) {
    return true;
  }

  if (/^WITH\b/i.test(normalized)) {
    return !WRITE_KEYWORDS.test(normalized);
  }

  return false;
}

import { log, newTraceId, runWithContext } from "./log.js";
import { QueryBridgeError, type ToolSuggestion } from "./errors.js";

export type { ToolSuggestion } from "./errors.js";

/**
 * Options accepted by the second-arg-as-object form of `toolError`.
 * The plain-string form (`toolError("msg", "hint")`) stays supported
 * via overload so older call sites keep working.
 */
export interface ToolErrorOpts {
  /** Operator-facing remediation text appended to the message. */
  hint?: string;
  /**
   * Stable identifier surfaced in `structuredContent.code`. Lets
   * agents branch on a fixed token instead of pattern-matching the
   * human-readable message.
   */
  code?: string;
  /**
   * Structured "what to call next" pointers. Each one becomes a bullet
   * in the rendered text AND lands in `structuredContent.suggestions`
   * for clients that consume modern MCP structured content.
   */
  suggestions?: readonly ToolSuggestion[];
}

// ── Shared tool annotations ───────────────────────────────────────

/**
 * Annotation block for any tool that reads from MySQL without
 * mutating state — list_tables, describe_table, sample_data, etc.
 * Idempotent because the same args yield the same result on a stable
 * schema; openWorld because we're reaching an external DB.
 *
 * Tools that don't touch a DB at all (e.g. list_connections) should
 * declare their own annotations with `openWorldHint: false`.
 */
export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Tool-side runtime: response envelopes, the toolHandler wrapper, MCP
 * extras, progress reporting, and error sanitization.
 *
 * Every tool depends on this module. It in turn depends only on
 * `log.ts` — a leaf — so the layering DAG stays clean.
 */

// ── Error sanitization ────────────────────────────────────────────

/**
 * Strip internal IPs, usernames, and hostnames from MySQL error
 * messages before they're returned to the MCP client (and thus to the
 * LLM). Operator-side logs use the raw message, not this.
 */
export function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/'[^']*'@'[^']*'/g, "'***'@'***'") // user@host patterns
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "***"); // IPv4
}

// ── Tool response envelopes ───────────────────────────────────────

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

/**
 * Wrap a predictable tool failure (read-only violation, validation
 * problem, "not found"). The MCP client sees `isError: true` and the
 * combined message + optional hint as the text content.
 *
 * Reserve `toolError` for *anticipated* failures the tool decides to
 * surface. System errors (MySQL exceptions, dropped connections)
 * should throw — `toolHandler` catches and sanitizes them.
 *
 * Two call shapes, both supported:
 *
 *   toolError("X not found")
 *   toolError("X not found", "Try Y instead.")           // legacy hint-only
 *   toolError("X not found", { hint, code, suggestions }) // structured form
 *
 * The structured form lets a tool emit machine-actionable next-step
 * pointers via `structuredContent.suggestions` while keeping the
 * rendered text equivalent to what a human reader would see.
 */
export function toolError(message: string, hint?: string): ToolErrorResult;
export function toolError(message: string, opts: ToolErrorOpts): ToolErrorResult;
export function toolError(
  message: string,
  hintOrOpts?: string | ToolErrorOpts,
): ToolErrorResult {
  const opts: ToolErrorOpts =
    typeof hintOrOpts === "string"
      ? { hint: hintOrOpts }
      : (hintOrOpts ?? {});

  const parts: string[] = [message];
  if (opts.hint) parts.push(`Hint: ${opts.hint}`);

  const suggestions = opts.suggestions ?? [];
  if (suggestions.length > 0) {
    parts.push(""); // blank line separates the bullet list from the hint
    parts.push("Try one of these tools next:");
    for (const s of suggestions) {
      const argsStr =
        s.args && Object.keys(s.args).length > 0
          ? ` (args: ${JSON.stringify(s.args)})`
          : "";
      parts.push(`  - ${s.tool} — ${s.reason}${argsStr}`);
    }
  }

  const result: ToolErrorResult = {
    content: [{ type: "text" as const, text: parts.join("\n") }],
    isError: true as const,
  };
  // Only emit structuredContent when there's actually something
  // machine-actionable to deliver — empty `{}` would just bloat the
  // wire response for clients that don't consume it.
  if (opts.code || suggestions.length > 0) {
    const sc: Record<string, unknown> = {};
    if (opts.code) sc.code = opts.code;
    if (suggestions.length > 0) sc.suggestions = suggestions;
    result.structuredContent = sc;
  }
  return result;
}

interface ToolErrorResult {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
  structuredContent?: Record<string, unknown>;
  // The SDK's tool-handler return type carries an open index signature
  // (so handlers can stash extra fields the spec doesn't model). Keep
  // ours assignable by declaring the same shape — the discriminating
  // `isError: true` literal still survives because it's narrower than
  // `unknown` and TypeScript preserves it.
  [key: string]: unknown;
}

/**
 * Discriminated union of every shape a tool handler may return. Use
 * this as the return type when a function shared across multiple
 * handlers can produce either outcome (e.g. `withCancellableQuery`).
 */
export type ToolResult = ReturnType<typeof toolOk> | ReturnType<typeof toolError>;

// ── Tool extras (request metadata, progress, cancellation) ────────

/**
 * Minimal subset of MCP's RequestHandlerExtra we actually consume.
 * Kept as a structural type so we don't import the SDK into this
 * module — and marked partial so callers can ignore it.
 */
export interface ToolExtra {
  signal?: AbortSignal;
  /**
   * The original request's _meta; carries progressToken when the
   * client opted in. Property values are explicitly `| undefined` to
   * satisfy exactOptionalPropertyTypes when the SDK passes its own
   * RequestMeta shape through.
   */
  _meta?: {
    progressToken?: string | number | undefined;
  } & Record<string, unknown>;
  /**
   * Send a notification (e.g. notifications/progress) back to the
   * client mid-call. Typed as `any` because the SDK's concrete
   * signature is a narrow discriminated union of ServerNotification
   * shapes we don't want to mirror in this structural type.
   * Construction happens in emitProgress() — that's the single trusted
   * call site.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendNotification?: (notification: any) => Promise<void>;
}

/**
 * Emit a progress notification if the client opted in by passing a
 * progressToken with the request. No-ops otherwise — clients that
 * didn't ask won't be spammed and we won't fail when the SDK plumbing
 * is absent (e.g. in tests).
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
      params: {
        progressToken: token,
        progress,
        total,
        ...(message ? { message } : {}),
      },
    });
  } catch {
    // Progress notifications are best-effort; never break the call over one.
  }
}

// ── toolHandler: uniform invocation envelope ──────────────────────

/**
 * Wrap a tool handler with uniform error handling and audit logging:
 *
 *   - Log every successful invocation (info on success, warn when
 *     the result carries isError) with elapsedMs.
 *   - Catch throws, sanitize the MySQL error message, return toolError.
 *
 * Without this wrapper, a thrown error propagates to the MCP SDK with
 * the original MySQL message — which can include 'user'@'host' and
 * internal IPs. Every handler that touches the database goes through
 * here; it's the security boundary, not a convenience.
 */
export function toolHandler<A extends Record<string, unknown>>(
  toolName: string,
  fn: (args: A, extra?: ToolExtra) => Promise<ToolResult>,
): (args: A, extra?: ToolExtra) => Promise<ToolResult> {
  return (args: A, extra?: ToolExtra) =>
    runWithContext({ traceId: newTraceId(), toolName }, async () => {
      const start = Date.now();
      const connection =
        typeof args?.connection === "string" ? args.connection : undefined;
      try {
        const result = await fn(args, extra);
        const isResultError = "isError" in result && result.isError === true;
        // toolName is in ambient context via runWithContext above, so
        // the merged log line already includes it as a separate field.
        // No need to interpolate it into the msg.
        log(isResultError ? "warn" : "info", "tool invoked", {
          connection,
          elapsedMs: Date.now() - start,
          ...(isResultError ? { rejected: true } : {}),
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // QueryBridgeError carries a stable code + hint, and optionally
        // structured next-step suggestions. Forward all three so the
        // agent gets the same machine-actionable response shape it
        // would have if the tool had returned toolError directly.
        // Tag the log line with the code so operators can grep for
        // "code=READ_ONLY_VIOLATION" instead of fragile message
        // substrings.
        if (err instanceof QueryBridgeError) {
          log("warn", "tool rejected", {
            connection,
            elapsedMs: Date.now() - start,
            code: err.code,
          });
          const opts: ToolErrorOpts = { code: err.code };
          if (err.hint) opts.hint = err.hint;
          if (err.suggestions && err.suggestions.length > 0) {
            opts.suggestions = err.suggestions;
          }
          return toolError(err.message, opts);
        }

        log("warn", "tool failed", {
          connection,
          elapsedMs: Date.now() - start,
          error: msg,
        });
        return toolError(`${toolName} failed: ${sanitizeErrorMessage(msg)}`);
      }
    });
}

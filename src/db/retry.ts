import { log } from "../log.js";

/**
 * Retry policy for transient connection-acquisition failures.
 *
 * Why this exists: when an SSH bastion drops idle tunnels or mysql2's
 * pool is mid-reconnect, the next `pool.getConnection()` can fail with
 * ECONNRESET, ETIMEDOUT, or PROTOCOL_CONNECTION_LOST. Those errors are
 * almost always transient — a single short retry has high upside and
 * near-zero downside.
 *
 * What this does NOT do:
 *  - Retry user queries. The caller decides if their `SELECT` is safe
 *    to re-run. We only retry the acquisition step.
 *  - Implement exponential backoff. One sleep, one retry — the
 *    failures we care about either clear immediately or won't clear
 *    at all on this connection.
 *  - Open a circuit breaker. The MCP workload is bounded by the
 *    LLM's request rate; we don't have the throughput problem
 *    breakers solve.
 */

/** Errors mysql2 / Node emit on a half-closed connection that should retry. */
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "PROTOCOL_CONNECTION_LOST",
  "EPIPE",
  "ENOTCONN",
]);

function isTransient(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

/**
 * Run `fn` once; if it throws a transient error, wait briefly and
 * retry exactly one more time. The successful or final failure is
 * returned/thrown as-is.
 *
 * `delayMs` should stay small — 100ms is enough for mysql2 to swap
 * a dead pool member, and large enough to avoid hot-looping on a
 * truly dead upstream.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  context: { connection: string; operation: string; delayMs?: number },
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err)) throw err;
    log("warn", `${context.operation} hit transient error; retrying once`, {
      connection: context.connection,
      code: (err as { code?: string }).code,
      message: err instanceof Error ? err.message : String(err),
    });
    await new Promise((resolve) => setTimeout(resolve, context.delayMs ?? 100));
    return fn();
  }
}

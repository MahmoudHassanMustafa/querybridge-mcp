import type { Pool, PoolConnection } from "mysql2/promise";
import { log } from "../log.js";
import { toolError, type ToolResult } from "../tool-runtime.js";
import { CancelledByClient } from "../errors.js";
import { withTransientRetry } from "./retry.js";

/**
 * Run `fn` against a pool worker connection with cooperative
 * cancellation wired up.
 *
 * Lifecycle:
 *   1. If the abort signal is already fired, bail with toolError.
 *   2. Acquire a worker connection, capture its CONNECTION_ID() so a
 *      later KILL QUERY can target it specifically.
 *   3. On signal abort: open a sibling connection (the worker is busy)
 *      and issue `KILL QUERY <id>`. Distinguish "killed by us" from
 *      other thrown errors via the `killed` flag.
 *   4. In `finally`: detach the abort listener and release the worker.
 *
 * Used by execute_query and explain_query — the only two tools that
 * run user-controlled queries long enough to merit cancellation.
 * Other tools rely on the pool-level `queryTimeout` instead.
 */
export async function withCancellableQuery(
  pool: Pool,
  opts: {
    connection: string;
    toolName: string;
    signal?: AbortSignal | undefined;
  },
  fn: (worker: PoolConnection) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (opts.signal?.aborted) {
    return toolError("Request was cancelled before execution started.");
  }

  let worker: PoolConnection | undefined;
  let connectionId: number | undefined;
  let killed = false;

  const onAbort = async (): Promise<void> => {
    if (connectionId == null) return;
    killed = true;
    try {
      const killer = await withTransientRetry(
        () => pool.getConnection(),
        { connection: opts.connection, operation: "kill-channel" },
      );
      try {
        // connectionId comes from `SELECT CONNECTION_ID()` on the same
        // pool a few statements earlier — MySQL guarantees a positive
        // integer. KILL does not accept a `?` placeholder, so direct
        // interpolation is the only option.
        // eslint-disable-next-line no-restricted-syntax
        await killer.query(`KILL QUERY ${connectionId}`);
        // toolName is in ambient context via toolHandler's
        // runWithContext, so the merged log line already shows it.
        log("info", "cancelled by client", {
          connection: opts.connection,
          connectionId,
        });
      } finally {
        killer.release();
      }
    } catch (err) {
      log("warn", "KILL failed", {
        connection: opts.connection,
        connectionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // Wrap pool acquisition in a single-retry — bastions sometimes drop
    // tunnels between requests, and mysql2's first failure after that is
    // transient. Retrying the user's query would be unsafe; retrying the
    // socket-level acquisition is not.
    worker = await withTransientRetry(() => pool.getConnection(), {
      connection: opts.connection,
      operation: "pool.getConnection",
    });
    const [idRows] = await worker.query("SELECT CONNECTION_ID() AS id");
    connectionId = (idRows as Array<{ id: number }>)[0]?.id;
    return await fn(worker);
  } catch (err) {
    // CancelledByClient flows through toolHandler so the operator
    // log records `code=CANCELLED_BY_CLIENT` rather than a generic
    // failure with the underlying mysql2 message.
    if (killed) throw new CancelledByClient(opts.toolName);
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    worker?.release();
  }
}

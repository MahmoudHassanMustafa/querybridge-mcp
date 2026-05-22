import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import type { DatabaseConfig, SSLConfig } from "./types.js";
import { log } from "./log.js";
import { createSSHTunnel, closeSSHTunnel } from "./ssh-tunnel.js";
import type { SSHTunnel } from "./ssh-tunnel.js";
import {
  DEFAULT_QUERY_TIMEOUT_MS,
  POOL_CONNECT_TIMEOUT_MS,
  POOL_QUEUE_LIMIT,
} from "./limits.js";
import { ConnectionNotFound } from "./errors.js";
import type { QueryRunner } from "./db/runner.js";

interface ManagedConnection {
  config: DatabaseConfig;
  /** The active query runner — pool-backed in prod, mock-backed in unit tests. */
  runner: QueryRunner;
  /**
   * Real mysql2 pool. Present for production connections; `undefined` for
   * mock connections registered by tests. Code that genuinely needs the
   * raw pool (cancellation via KILL QUERY, per-connection USE before
   * user SQL) must check for `undefined` and fall back gracefully.
   */
  pool?: Pool;
  tunnel?: SSHTunnel;
}

/**
 * Build a runner that wraps the given pool with the connection's
 * configured timeout. `queryWithTimeout` delegates to whichever runner
 * the connection registry holds, so swapping in a mock for tests is
 * just `registerMockConnection(name, mockRunner)`.
 */
function poolRunner(pool: Pool, timeoutMs: number): QueryRunner {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T> {
      const [rows] = await pool.query({ sql, timeout: timeoutMs }, params);
      return rows as T;
    },
  };
}

const connections = new Map<string, ManagedConnection>();

/**
 * Build mysql2 pool options from a database config. Shared by
 * `initConnection` (long-lived server pool) and `pingConnection`
 * (one-shot CLI connectivity test) so the security hardening —
 * `multipleStatements: false`, `flags: ["-LOCAL_FILES"]`,
 * `infileStreamFactory` — applies uniformly. Don't reach for mysql2
 * directly elsewhere; route through here.
 */
function buildPoolOptions(
  config: DatabaseConfig,
  host: string,
  port: number,
): mysql.PoolOptions {
  // Build incrementally so explicit-undefined keys don't break under
  // exactOptionalPropertyTypes (mysql2 declares password/database as
  // non-optional in its PoolOptions type).
  const poolOpts: mysql.PoolOptions = {
    host,
    port,
    user: config.user,
    waitForConnections: true,
    connectionLimit: config.poolSize,
    queueLimit: POOL_QUEUE_LIMIT,
    connectTimeout: POOL_CONNECT_TIMEOUT_MS,
    multipleStatements: false,
    // Disable LOAD DATA LOCAL INFILE on every pool. mysql2 ≥ 2.0 already
    // requires `infileStreamFactory` to opt in, but we drop the
    // LOCAL_FILES capability flag so the server isn't told we support it,
    // AND install a factory that throws — three defenses against any
    // future regression in mysql2's defaults.
    flags: ["-LOCAL_FILES"],
    infileStreamFactory: () => {
      throw new Error("LOAD DATA LOCAL INFILE is disabled by querybridge-mcp");
    },
  };
  if (config.password !== undefined) poolOpts.password = config.password;
  if (config.database) poolOpts.database = config.database;

  if (config.ssl) {
    if (config.ssl === true) {
      poolOpts.ssl = {};
    } else {
      const sslCfg = config.ssl as SSLConfig;
      if (sslCfg.rejectUnauthorized === false) {
        log(
          "warn",
          "SSL certificate validation is DISABLED; vulnerable to MITM",
          { connection: config.name },
        );
      }
      // Build incrementally so we don't emit explicit-undefined keys —
      // mysql2's SslOptions disallows `undefined` under exactOptionalPropertyTypes.
      const ssl: Record<string, unknown> = {
        rejectUnauthorized: sslCfg.rejectUnauthorized ?? true,
      };
      if (sslCfg.ca) ssl.ca = readFileSync(sslCfg.ca);
      if (sslCfg.cert) ssl.cert = readFileSync(sslCfg.cert);
      if (sslCfg.key) ssl.key = readFileSync(sslCfg.key);
      poolOpts.ssl = ssl as NonNullable<mysql.PoolOptions["ssl"]>;
    }
  }

  return poolOpts;
}

/**
 * Open and register a long-lived connection pool for `config.name`.
 * Establishes the SSH tunnel first (if configured), builds the pool
 * with hardening from `buildPoolOptions`, applies the read-only
 * session settings via `hardenSession`, and verifies the connection
 * with one synchronous handshake before returning.
 *
 * Idempotent: a second call with the same `config.name` is a no-op,
 * which is what the multi-connection startup loop relies on.
 *
 * Throws on any failure. The catch path tears down the tunnel and
 * pool that were created, so a failed init never leaks resources.
 */
export async function initConnection(config: DatabaseConfig): Promise<void> {
  if (connections.has(config.name)) return;

  let mysqlHost = config.host;
  let mysqlPort = config.port;
  let tunnel: SSHTunnel | undefined;
  let pool: mysql.Pool | undefined;

  try {
    if (config.ssh) {
      tunnel = await createSSHTunnel(config);
      mysqlHost = tunnel.host;
      mysqlPort = tunnel.port;
    }

    // buildPoolOptions can throw (readFileSync on SSL certs). The outer
    // try guarantees the SSH tunnel is torn down if that happens — the
    // earlier nested-try shape leaked the tunnel on SSL-load failure.
    const poolOpts = buildPoolOptions(config, mysqlHost, mysqlPort);
    pool = mysql.createPool(poolOpts);
    hardenSession(pool, config);
    const conn = await pool.getConnection();
    conn.release();

    const managed: ManagedConnection = {
      config,
      pool,
      runner: poolRunner(pool, config.queryTimeout ?? DEFAULT_QUERY_TIMEOUT_MS),
    };
    if (tunnel) managed.tunnel = tunnel;
    connections.set(config.name, managed);
  } catch (err) {
    if (pool) await pool.end().catch(() => {});
    if (tunnel) closeSSHTunnel(tunnel);
    throw err;
  }
}

/**
 * One-shot connectivity check. Builds a single-connection pool using
 * the same hardening as `initConnection`, runs `SELECT VERSION()` and
 * `SHOW DATABASES`, then tears everything down. Used by the CLI's
 * test command so changes to pool hardening propagate automatically.
 *
 * Throws on any failure — caller decides how to render the message.
 */
export async function pingConnection(
  config: DatabaseConfig,
): Promise<{ version: string; databaseCount: number }> {
  let mysqlHost = config.host;
  let mysqlPort = config.port;
  let tunnel: SSHTunnel | undefined;
  let pool: mysql.Pool | undefined;

  try {
    if (config.ssh) {
      tunnel = await createSSHTunnel(config);
      mysqlHost = tunnel.host;
      mysqlPort = tunnel.port;
    }

    const poolOpts = buildPoolOptions(config, mysqlHost, mysqlPort);
    // Connectivity check needs a single connection, not the configured
    // pool size — keep it tight so the test doesn't open more sockets
    // than necessary.
    poolOpts.connectionLimit = 1;
    pool = mysql.createPool(poolOpts);

    const conn = await pool.getConnection();
    try {
      const [verRows] = await conn.query("SELECT VERSION() AS version");
      const version =
        (verRows as Array<{ version: string }>)[0]?.version ?? "unknown";

      const [dbs] = await conn.query("SHOW DATABASES");
      const databaseCount = (dbs as unknown[]).length;

      return { version, databaseCount };
    } finally {
      conn.release();
    }
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (tunnel) closeSSHTunnel(tunnel);
  }
}

/**
 * Run session-hardening statements on every new physical connection in
 * the pool. The `connection` event fires synchronously when mysql2 adds
 * a freshly-opened connection to its internal list — before any caller
 * issues their first query — so these statements queue ahead of user
 * work on each connection.
 *
 *  - `transaction_read_only` is the SESSION variable (persists for the
 *    connection's lifetime). Plain `SET TRANSACTION READ ONLY` would
 *    only apply to the next transaction, so we use the variable form.
 *  - `sql_safe_updates` blocks UPDATE/DELETE without an indexed WHERE,
 *    in case the SQL-text whitelist is ever bypassed.
 *
 * Only applied to readonly: true connections. Failures are logged but
 * don't break the pool — they'd typically mean an older MySQL/MariaDB
 * version that doesn't recognise the variable name.
 */
function hardenSession(pool: Pool, config: DatabaseConfig): void {
  if (!config.readonly) return;
  pool.on("connection", (conn) => {
    // mysql2 quirk: the `connection` event always delivers the
    // callback-style PoolConnection — even when the pool was created
    // via mysql2/promise. Calling `.query(sql)` without a callback
    // dispatches the query but logs a "not a promise" misuse warning
    // to stderr. Use the callback signature explicitly to avoid that
    // and to actually surface failures.
    const callbackConn = conn as unknown as {
      query: (
        sql: string,
        cb: (err: Error | null) => void,
      ) => void;
    };
    callbackConn.query(
      "SET SESSION transaction_read_only = 1, SESSION sql_safe_updates = 1",
      (err) => {
        if (err) {
          log("warn", "failed to apply read-only session hardening", {
            connection: config.name,
            error: err.message,
          });
        }
      },
    );
  });
}

/**
 * Look up the mysql2 pool for a registered connection. Throws if the
 * connection name has never been initialized, or if the connection
 * was registered as a unit-test mock (no real pool).
 *
 * Code that genuinely needs the raw pool — `withCancellableQuery` for
 * sibling-connection KILL, `execute_query` for `USE <db>` on the
 * worker — uses this. Anything that just runs a single query should
 * use `queryWithTimeout` instead so it stays mockable.
 */
export function getPool(name: string): Pool {
  const managed = connections.get(name);
  if (!managed) throw new ConnectionNotFound(name);
  if (!managed.pool) {
    throw new Error(
      `Connection "${name}" is a mock without a backing pool — cancellation/USE paths require a real connection.`,
    );
  }
  return managed.pool;
}

/** Look up the resolved config for a registered connection. Throws if
 *  the connection is not initialized. */
export function getConnectionConfig(name: string): DatabaseConfig {
  const managed = connections.get(name);
  if (!managed) throw new ConnectionNotFound(name);
  return managed.config;
}

/**
 * Mutate the in-memory active database for a connection (the value
 * `use_database` updates). The pool itself does not switch — every
 * subsequent query that resolves a default schema picks this up via
 * `resolveDb` / `getConnectionConfig`.
 */
export function setActiveDatabase(name: string, database: string): void {
  const managed = connections.get(name);
  if (!managed) throw new ConnectionNotFound(name);
  managed.config.database = database;
}

/** Names of every currently-initialized connection, in insertion order. */
export function listConnectionNames(): string[] {
  return [...connections.keys()];
}

/** Resolved query timeout for a connection — falls back to the global
 *  default if the connection has no explicit override. */
export function getQueryTimeout(name: string): number {
  return getConnectionConfig(name).queryTimeout ?? DEFAULT_QUERY_TIMEOUT_MS;
}

/**
 * Run a query through the pool with the connection's configured timeout
 * applied as the mysql2 client-side timeout. Returns just the rows.
 *
 * Use this for information_schema reads and other schema-introspection
 * queries that can be slow on large servers — without a timeout, a slow
 * query would hang the MCP tool call past Claude Code's request deadline.
 * On timeout expiry mysql2 destroys the underlying connection; the pool
 * replaces it on the next call.
 */
export async function queryWithTimeout<T = unknown>(
  connection: string,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const managed = connections.get(connection);
  if (!managed) throw new ConnectionNotFound(connection);
  return managed.runner.query<T>(sql, params);
}

/**
 * Tear down every registered connection: end the pool, close the SSH
 * tunnel, remove from the registry. Errors during shutdown are logged
 * but never thrown — shutdown is best-effort and must not block the
 * process from exiting.
 */
export async function closeAll(): Promise<void> {
  for (const [name, managed] of connections) {
    try {
      // Mock connections registered by tests have no pool to end.
      if (managed.pool) await managed.pool.end();
    } catch (err) {
      log("warn", "pool close failed during shutdown", {
        connection: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (managed.tunnel) closeSSHTunnel(managed.tunnel);
    connections.delete(name);
  }
}

/**
 * Register a connection backed by a custom `QueryRunner` instead of a
 * real mysql2 pool. Intended for unit tests — production code never
 * calls this.
 *
 * After registration, every call that goes through `queryWithTimeout`
 * (and therefore every `db/introspection.ts` helper) is served by the
 * runner. Real-pool-only paths like `getPool(name)`,
 * `withCancellableQuery`, and `execute_query`'s `USE` step will throw
 * with a clear message because the mock has no underlying socket to
 * cancel.
 *
 * The provided `config` is shallow-merged onto a sensible default so
 * tests don't have to repeat the boilerplate.
 */
export function registerMockConnection(
  name: string,
  runner: QueryRunner,
  config: Partial<DatabaseConfig> = {},
): void {
  const merged: DatabaseConfig = {
    name,
    host: "mock",
    port: 0,
    user: "mock",
    readonly: true,
    poolSize: 1,
    ...config,
  };
  connections.set(name, { config: merged, runner });
}

/**
 * Test-only helper: drop all registered connections (real or mock)
 * without going through pool teardown. Use in `afterEach` so test
 * suites stay isolated.
 */
export function __resetConnectionsForTests(): void {
  connections.clear();
}

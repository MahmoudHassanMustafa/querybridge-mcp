import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import type { DatabaseConfig, SSLConfig } from "./types.js";
import { log } from "./helpers.js";
import { createSSHTunnel, closeSSHTunnel } from "./ssh-tunnel.js";
import type { SSHTunnel } from "./ssh-tunnel.js";

interface ManagedConnection {
  config: DatabaseConfig;
  pool: Pool;
  tunnel?: SSHTunnel;
}

const connections = new Map<string, ManagedConnection>();

export async function initConnection(config: DatabaseConfig): Promise<void> {
  if (connections.has(config.name)) return;

  let mysqlHost = config.host;
  let mysqlPort = config.port;
  let tunnel: SSHTunnel | undefined;

  if (config.ssh) {
    tunnel = await createSSHTunnel(config);
    mysqlHost = tunnel.host;
    mysqlPort = tunnel.port;
  }

  // Build incrementally so explicit-undefined keys don't break under
  // exactOptionalPropertyTypes (mysql2 declares password/database as
  // non-optional in its PoolOptions type).
  const poolOpts: mysql.PoolOptions = {
    host: mysqlHost,
    port: mysqlPort,
    user: config.user,
    waitForConnections: true,
    connectionLimit: config.poolSize,
    queueLimit: 10,
    connectTimeout: 10000,
    multipleStatements: false,
    // Disable LOAD DATA LOCAL INFILE on every pool. mysql2 ≥ 2.0 already
    // requires `infileStreamFactory` to opt in, but we drop the
    // LOCAL_FILES capability flag so the server isn't told we support it,
    // AND install a factory that throws — three defenses against any
    // future regression in mysql2's defaults.
    flags: ["-LOCAL_FILES"],
    infileStreamFactory: () => {
      throw new Error(
        "LOAD DATA LOCAL INFILE is disabled by querybridge-mcp",
      );
    },
  };
  if (config.password !== undefined) poolOpts.password = config.password;
  if (config.database) poolOpts.database = config.database;

  // SSL/TLS support
  if (config.ssl) {
    if (config.ssl === true) {
      poolOpts.ssl = {};
    } else {
      const sslCfg = config.ssl as SSLConfig;
      if (sslCfg.rejectUnauthorized === false) {
        log(
          "warn",
          "SSL certificate validation is DISABLED; vulnerable to MITM",
          { connection: config.name }
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

  let pool: mysql.Pool;
  try {
    pool = mysql.createPool(poolOpts);
    hardenSession(pool, config);
    const conn = await pool.getConnection();
    conn.release();
  } catch (err) {
    // Clean up SSH tunnel if pool creation/verification fails
    if (tunnel) closeSSHTunnel(tunnel);
    throw err;
  }

  const managed: ManagedConnection = { config, pool };
  if (tunnel) managed.tunnel = tunnel;
  connections.set(config.name, managed);
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

export function getPool(name: string): Pool {
  const managed = connections.get(name);
  if (!managed) {
    throw new Error(`Connection "${name}" not found or not initialized`);
  }
  return managed.pool;
}

export function getConnectionConfig(name: string): DatabaseConfig {
  const managed = connections.get(name);
  if (!managed) {
    throw new Error(`Connection "${name}" not found`);
  }
  return managed.config;
}

export function setActiveDatabase(name: string, database: string): void {
  const managed = connections.get(name);
  if (!managed) {
    throw new Error(`Connection "${name}" not found`);
  }
  managed.config.database = database;
}

export function listConnectionNames(): string[] {
  return [...connections.keys()];
}

export function getQueryTimeout(name: string): number {
  return getConnectionConfig(name).queryTimeout ?? 30000;
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
  const pool = getPool(connection);
  const timeout = getQueryTimeout(connection);
  const [rows] = await pool.query({ sql, timeout }, params);
  return rows as T;
}

export async function closeAll(): Promise<void> {
  for (const [name, managed] of connections) {
    try {
      await managed.pool.end();
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

/**
 * Centralised limits and budget constants.
 *
 * Each constant carries its rationale inline. When you change one, update
 * the comment with the new reasoning — the *why* is the load-bearing
 * part, not the number.
 */

/**
 * Max characters rendered per table cell in formatAsTable().
 *
 * 120 balances readability against information loss for long values
 * (URLs, JSON, view bodies, error messages). The byte cap below still
 * bounds total output, so loosening the per-cell cap is safe; tightening
 * starts hiding useful prefixes of long values.
 */
export const MAX_COL_WIDTH = 120;

/**
 * Hard cap on total formatted table output, in bytes.
 *
 * 500 wide rows with TEXT/JSON/BLOB columns can easily run into the
 * multi-MB range. Anthropic's API has been observed to respond with
 * 500-class errors on those, instead of a clean context-size refusal.
 * 256KB stays well under any practical token budget while still
 * returning meaningful tables.
 */
export const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Auto-LIMIT injected into unbounded SELECT in execute_query.
 *
 * 1000 keeps a runaway `SELECT * FROM big_table` from streaming the
 * entire heap into the buffer. The MCP client almost never needs more
 * than this in one shot; if you do, ask for it explicitly with LIMIT in
 * the query. Pairing with MAX_OUTPUT_BYTES guarantees the response
 * stays bounded even on wide rows.
 */
export const MAX_RESULT_ROWS = 1000;

/**
 * IN-list chunk size for information_schema bulk lookups in compare_schemas.
 *
 * MySQL's max_allowed_packet defaults to 64MB, and a single SQL with
 * thousands of literal table names in an IN-list approaches that limit
 * on busy servers. 500 keeps each chunk small enough to plan/execute
 * quickly while minimising round-trips for schemas with many tables.
 */
export const COMPARE_CHUNK_SIZE = 500;

/**
 * mysql2 pool connectTimeout, in ms.
 *
 * 10s: long enough to cover slow DNS + TLS + SSH tunnel handshake on a
 * cold start; short enough that a misconfigured host fails fast at
 * startup instead of hanging the MCP server.
 */
export const POOL_CONNECT_TIMEOUT_MS = 10_000;

/**
 * mysql2 pool queueLimit — max queries waiting for a free connection
 * before mysql2 starts rejecting with a queue-overflow error.
 *
 * 10 is plenty for an LLM-driven workload (typical concurrency is 1–3)
 * while still bounding memory when a misbehaving agent dispatches many
 * tools in parallel against a single-connection pool.
 */
export const POOL_QUEUE_LIMIT = 10;

/**
 * Default query timeout when a connection does not override it, in ms.
 *
 * 30s covers most operator and agent workloads. Slow information_schema
 * reads on huge servers do approach this; if you regularly hit it,
 * raise `queryTimeout` on the specific connection in config rather than
 * the global default.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

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

/**
 * Default row cap for `streaming_query` when the operator does not pass
 * an explicit `max_rows`. 1M rows on a typical 200-byte average row is
 * ~200MB on disk — large enough for real exports, small enough that a
 * runaway query stops well before filling the volume.
 */
export const DEFAULT_STREAM_ROWS = 1_000_000;

/**
 * Hard ceiling on `streaming_query`'s `max_rows` argument. 100M is the
 * point past which we'd rather the operator pull the data via a real
 * ETL pipeline than through an MCP tool — both for runtime sanity and
 * to keep the disk-DoS blast radius bounded.
 */
export const MAX_STREAM_ROWS_CEILING = 100_000_000;

/**
 * Default byte cap for `streaming_query`'s output file, in bytes (1 GiB).
 * Pairs with the row cap — whichever is hit first stops the stream and
 * marks the result `truncated: true`. The pair matters because a single
 * wide row (BLOB/JSON) can blow past the disk budget long before the
 * row count would.
 */
export const DEFAULT_STREAM_BYTES = 1024 * 1024 * 1024;

/**
 * Hard ceiling on `streaming_query`'s `max_bytes` argument (10 GiB).
 * See [[MAX_STREAM_ROWS_CEILING]] — same reasoning, different units.
 */
export const MAX_STREAM_BYTES_CEILING = 10 * 1024 * 1024 * 1024;

/**
 * Emit a `notifications/progress` from `streaming_query` every Nth row.
 * 1000 keeps the wire-traffic on a 1M-row export to ~1k notifications
 * — frequent enough that an agent UI feels live, sparse enough not to
 * dominate the bytes spent on the actual rows.
 */
export const STREAM_PROGRESS_ROW_INTERVAL = 1000;

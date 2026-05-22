/**
 * QueryRunner: the unit-test seam for everything that reads from
 * MySQL.
 *
 * Production: `connection.ts` wraps each mysql2 Pool in a runner that
 * applies the connection's `queryTimeout` and delegates to
 * `pool.query`. Nothing observable changes — `queryWithTimeout` and
 * every existing introspection helper keeps working.
 *
 * Tests: `registerMockConnection(name, runner)` swaps in a fake. The
 * tool handler runs unchanged; the runner returns canned rows; the
 * handler's rendering logic is exercised end-to-end **without
 * Docker, without testcontainers, without a real MySQL**.
 *
 * The interface is deliberately minimal — only what `queryWithTimeout`
 * needs. Operations that require a raw `pool.getConnection()`
 * (cancellation via KILL QUERY, USE statements before user SQL) stay
 * on the real `getPool(name)` path; those handlers remain integration-
 * only by design.
 */
export interface QueryRunner {
  /**
   * Execute `sql` with the given parameter bindings. Returns the rows
   * cast to T — the caller is responsible for declaring the row shape.
   */
  query<T>(sql: string, params?: unknown[]): Promise<T>;
}

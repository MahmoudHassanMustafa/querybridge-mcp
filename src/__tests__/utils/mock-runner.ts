import type { QueryRunner } from "../../db/runner.js";

/**
 * Builder-style mock QueryRunner for unit tests.
 *
 * Usage:
 *
 *   const runner = new MockRunner()
 *     .whenSql(/^SHOW DATABASES$/, [{ Database: "test" }])
 *     .whenSql(/information_schema\.TABLES/, [
 *       { TABLE_NAME: "users" },
 *       { TABLE_NAME: "orders" },
 *     ]);
 *   registerMockConnection("test-conn", runner);
 *
 *   // …call introspection / tool handlers…
 *
 *   expect(runner.calls()).toHaveLength(2);
 *   expect(runner.calls()[1].params).toEqual(["test"]);
 *
 * The first matching `whenSql` wins. An unmatched query throws — that
 * forces tests to declare every SQL they expect, instead of silently
 * returning `[]` and masking regressions.
 */
export class MockRunner implements QueryRunner {
  private rules: Array<{ pattern: RegExp; rows: unknown }> = [];
  private invocations: Array<{ sql: string; params: unknown[] }> = [];

  whenSql(pattern: RegExp, rows: unknown): this {
    this.rules.push({ pattern, rows });
    return this;
  }

  /**
   * Return every query the runner has seen, in order. Useful for
   * asserting that a tool executes the expected SQL with the expected
   * parameter bindings.
   */
  calls(): ReadonlyArray<{ sql: string; params: unknown[] }> {
    return this.invocations;
  }

  /** Forget every recorded call. Rules stay configured. */
  resetCalls(): void {
    this.invocations = [];
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T> {
    this.invocations.push({ sql, params });
    for (const rule of this.rules) {
      if (rule.pattern.test(sql)) {
        return rule.rows as T;
      }
    }
    throw new Error(
      `MockRunner: no rule matched SQL:\n${sql}\n\nRegister one with .whenSql(pattern, rows).`,
    );
  }
}

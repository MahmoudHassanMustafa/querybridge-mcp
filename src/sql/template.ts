/**
 * Tagged SQL template literal.
 *
 * Produces a `{ sql, values }` object directly assignable to mysql2's
 * `query()` / `execute()` overload that accepts a QueryOptions. The
 * goal is twofold:
 *
 *   1. Make value interpolation safe by default. Bare interpolations
 *      become `?` placeholders + bound values — never spliced into
 *      the SQL text.
 *
 *   2. Make the unsafe-by-necessity cases explicit. MySQL refuses
 *      placeholder bindings in some positions (KILL `<id>`, USE
 *      `<db>`, SHOW CREATE PROCEDURE `<db>.<name>`). Those used to
 *      need an `eslint-disable no-restricted-syntax` comment; here
 *      they call `id()` or `raw()` to make the intent visible at
 *      the use site.
 *
 * Example:
 *
 *   import { sql, id, raw } from "./template.js";
 *
 *   await worker.query(sql`KILL QUERY ${raw(connectionId)}`);
 *   await worker.query(sql`SHOW CREATE PROCEDURE ${id(db)}.${id(name)}`);
 *   await worker.query(sql`SELECT * FROM users WHERE id = ${userId}`);
 *
 * The first two cases inline the value into the SQL text (with
 * identifier escaping for `id()` and an integer-only guard for
 * `raw()`). The third becomes `SELECT * FROM users WHERE id = ?`
 * with `userId` bound as a parameter.
 *
 * Composition / nested `sql\`\`` blocks are intentionally NOT
 * supported in V1 — every case in the codebase today is a single
 * statement assembled at one call site.
 */

import { escapeId } from "./identifiers.js";

class Identifier {
  constructor(public readonly name: string) {}
}

class RawInteger {
  constructor(public readonly value: number) {}
}

/**
 * Wrap an identifier (table, column, database, index name) so the
 * tagged template inlines it with backtick-escaping. The escaping
 * happens via the same `escapeId` used elsewhere in the codebase —
 * one source of truth.
 */
export function id(name: string): Identifier {
  return new Identifier(name);
}

/**
 * Inline a known-safe integer literal into the SQL. Refuses anything
 * that isn't a finite integer — guards against accidental string
 * interpolation through this escape hatch.
 *
 * Use for SQL positions MySQL doesn't accept `?` placeholders in —
 * primarily `KILL QUERY <id>` / `KILL CONNECTION <id>`, where the
 * value is an integer thread id returned by `CONNECTION_ID()` or
 * `information_schema.PROCESSLIST`.
 */
export function raw(value: number): RawInteger {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`raw() requires a finite integer; got ${String(value)}`);
  }
  return new RawInteger(value);
}

export interface SqlQuery {
  /**
   * Composed SQL text. Identifiers spliced as backtick-escaped,
   * `raw()` integers spliced verbatim, everything else replaced with
   * a `?` placeholder.
   */
  sql: string;
  /**
   * Values bound to the `?` placeholders, in left-to-right order.
   */
  values: unknown[];
}

/**
 * Tagged template literal that produces an mysql2-ready
 * `{ sql, values }` object. See file header for the contract.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  const parts: string[] = [];
  const bound: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    // `strings` is a TemplateStringsArray — every slot is defined by
    // the template-literal spec, but TS narrows on `.at()` rather than
    // index access. Use index with a non-null assertion via a runtime
    // fallback so a bug never propagates as `undefined` into the SQL.
    const lit = strings[i];
    parts.push(lit ?? "");
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Identifier) {
        parts.push(escapeId(v.name));
      } else if (v instanceof RawInteger) {
        parts.push(String(v.value));
      } else {
        parts.push("?");
        bound.push(v);
      }
    }
  }
  return { sql: parts.join(""), values: bound };
}

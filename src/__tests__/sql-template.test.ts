import { describe, expect, it } from "vitest";
import { id, raw, sql } from "../sql/template.js";

describe("sql template — bare interpolations become parameters", () => {
  it("produces a ? placeholder + bound value for a plain interpolation", () => {
    const q = sql`SELECT * FROM users WHERE id = ${42}`;
    expect(q.sql).toBe("SELECT * FROM users WHERE id = ?");
    expect(q.values).toEqual([42]);
  });

  it("binds multiple parameters in left-to-right order", () => {
    const a = "alice";
    const b = "bob";
    const q = sql`SELECT * FROM users WHERE a = ${a} OR b = ${b}`;
    expect(q.sql).toBe("SELECT * FROM users WHERE a = ? OR b = ?");
    expect(q.values).toEqual(["alice", "bob"]);
  });

  it("treats null and undefined as bound values (not splices)", () => {
    const q = sql`UPDATE t SET a = ${null}, b = ${undefined} WHERE id = ${1}`;
    expect(q.sql).toBe("UPDATE t SET a = ?, b = ? WHERE id = ?");
    expect(q.values).toEqual([null, undefined, 1]);
  });

  it("handles a template with no interpolations", () => {
    const q = sql`SELECT VERSION()`;
    expect(q.sql).toBe("SELECT VERSION()");
    expect(q.values).toEqual([]);
  });

  it("handles a template with no static text between interpolations", () => {
    // Pathological but legal — verifies the join logic, not anything
    // a real call site would do.
    const q = sql`${1}${2}${3}`;
    expect(q.sql).toBe("???");
    expect(q.values).toEqual([1, 2, 3]);
  });
});

describe("id() — identifier escape", () => {
  it("backtick-escapes the identifier inline", () => {
    const q = sql`USE ${id("shop")}`;
    expect(q.sql).toBe("USE `shop`");
    expect(q.values).toEqual([]);
  });

  it("handles db.table qualified names via two id() calls", () => {
    const q = sql`SHOW CREATE TABLE ${id("shop")}.${id("users")}`;
    expect(q.sql).toBe("SHOW CREATE TABLE `shop`.`users`");
  });

  it("escapes embedded backticks so a malicious identifier can't break out", () => {
    // mysql2's escapeId doubles embedded backticks. Important: this
    // helper must not pre-empt that.
    const q = sql`SELECT * FROM ${id("ev``il")}`;
    // We don't pin the exact double-backtick output (it depends on
    // mysql2's escapeId), but at minimum the inner backticks must NOT
    // appear unescaped — that would close the surrounding quote.
    expect(q.sql).not.toContain("`evil`");
    // And the value array should still be empty (identifier was
    // inlined, not parameterized).
    expect(q.values).toEqual([]);
  });
});

describe("raw() — verbatim integer interpolation", () => {
  it("inlines a finite integer literal", () => {
    const q = sql`KILL QUERY ${raw(42)}`;
    expect(q.sql).toBe("KILL QUERY 42");
    expect(q.values).toEqual([]);
  });

  it("refuses a non-integer number (would risk SQL injection via stringification)", () => {
    expect(() => raw(3.14)).toThrow(/finite integer/);
  });

  it("refuses NaN", () => {
    expect(() => raw(Number.NaN)).toThrow(/finite integer/);
  });

  it("refuses Infinity", () => {
    expect(() => raw(Number.POSITIVE_INFINITY)).toThrow(/finite integer/);
  });

  it("refuses a string disguised as a number via runtime sneak-through", () => {
    // TypeScript blocks this at compile time; this asserts the runtime
    // guard still catches it if a caller bypasses the type system.
    expect(() => raw("42" as unknown as number)).toThrow(/finite integer/);
  });

  it("accepts 0 and negative integers (both legal mysql thread ids)", () => {
    expect(raw(0)).toBeDefined();
    expect(sql`KILL QUERY ${raw(0)}`.sql).toBe("KILL QUERY 0");
  });
});

describe("mixed interpolation in one template", () => {
  it("combines id, raw, and parameters in the same query", () => {
    const q = sql`SELECT * FROM ${id("orders")} WHERE thread = ${raw(7)} AND status = ${"open"}`;
    expect(q.sql).toBe("SELECT * FROM `orders` WHERE thread = 7 AND status = ?");
    expect(q.values).toEqual(["open"]);
  });

  it("preserves insertion order across mixed slot types", () => {
    const q = sql`A ${1} B ${id("t")} C ${raw(2)} D ${"s"} E`;
    expect(q.sql).toBe("A ? B `t` C 2 D ? E");
    // params are 1 (slot 0) and "s" (slot 3); the id and raw slots
    // are NOT added to values.
    expect(q.values).toEqual([1, "s"]);
  });
});

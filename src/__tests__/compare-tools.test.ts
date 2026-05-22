import { describe, it, expect } from "vitest";
import {
  diffColumns,
  diffIndexes,
  diffForeignKeys,
  type Column,
  type IndexDef,
  type ForeignKey,
} from "../tools/compare-tools.js";

// ── diffColumns ─────────────────────────────────────────────────────

describe("diffColumns", () => {
  const col = (overrides: Partial<Column>): Column => ({
    name: "id",
    type: "int(11)",
    nullable: false,
    default: null,
    key: "PRI",
    ...overrides,
  });

  it("returns empty diff for identical column sets", () => {
    const a = [col({ name: "id" }), col({ name: "email", type: "varchar(255)", key: "" })];
    const b = [col({ name: "id" }), col({ name: "email", type: "varchar(255)", key: "" })];
    const d = diffColumns(a, b);
    expect(d.onlyInSource).toEqual([]);
    expect(d.onlyInTarget).toEqual([]);
    expect(d.modified).toEqual([]);
  });

  it("detects columns only in source", () => {
    const a = [col({ name: "id" }), col({ name: "deprecated", key: "" })];
    const b = [col({ name: "id" })];
    const d = diffColumns(a, b);
    expect(d.onlyInSource.map((c) => c.name)).toEqual(["deprecated"]);
    expect(d.onlyInTarget).toEqual([]);
    expect(d.modified).toEqual([]);
  });

  it("detects columns only in target", () => {
    const a = [col({ name: "id" })];
    const b = [col({ name: "id" }), col({ name: "new_field", type: "tinyint(1)", key: "" })];
    const d = diffColumns(a, b);
    expect(d.onlyInSource).toEqual([]);
    expect(d.onlyInTarget.map((c) => c.name)).toEqual(["new_field"]);
  });

  it("detects type changes", () => {
    const a = [col({ name: "status", type: "varchar(20)", key: "" })];
    const b = [col({ name: "status", type: "varchar(50)", key: "" })];
    const d = diffColumns(a, b);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.diffs[0]).toContain("type: varchar(20) → varchar(50)");
  });

  it("detects nullable flip", () => {
    const a = [col({ name: "x", nullable: false, key: "" })];
    const b = [col({ name: "x", nullable: true, key: "" })];
    const d = diffColumns(a, b);
    expect(d.modified[0]!.diffs.some((s) => s.includes("nullable"))).toBe(true);
  });

  it("detects default change including NULL boundaries", () => {
    const a = [col({ name: "x", default: null, key: "" })];
    const b = [col({ name: "x", default: "0", key: "" })];
    const d = diffColumns(a, b);
    expect(d.modified[0]!.diffs.some((s) => s.includes("default: NULL → '0'"))).toBe(true);
  });

  it("returns sorted output", () => {
    const a = [col({ name: "zebra" }), col({ name: "alpha" })];
    const b: Column[] = [];
    const d = diffColumns(a, b);
    expect(d.onlyInSource.map((c) => c.name)).toEqual(["alpha", "zebra"]);
  });

  it("handles empty inputs", () => {
    const d = diffColumns([], []);
    expect(d.onlyInSource).toEqual([]);
    expect(d.onlyInTarget).toEqual([]);
    expect(d.modified).toEqual([]);
  });

  it("collects multiple changes on one column", () => {
    const a = [col({ name: "x", type: "int", nullable: false, default: null, key: "" })];
    const b = [col({ name: "x", type: "bigint", nullable: true, default: "0", key: "MUL" })];
    const d = diffColumns(a, b);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.diffs.length).toBe(4);
  });
});

// ── diffIndexes ─────────────────────────────────────────────────────

describe("diffIndexes", () => {
  const idx = (overrides: Partial<IndexDef>): IndexDef => ({
    name: "PRIMARY",
    columns: ["id"],
    unique: true,
    type: "BTREE",
    ...overrides,
  });

  it("matches identical index sets", () => {
    const d = diffIndexes([idx({})], [idx({})]);
    expect(d.modified).toEqual([]);
  });

  it("detects added/removed indexes", () => {
    const a = [idx({ name: "PRIMARY" })];
    const b = [idx({ name: "PRIMARY" }), idx({ name: "idx_email", columns: ["email"], unique: false })];
    const d = diffIndexes(a, b);
    expect(d.onlyInTarget.map((i) => i.name)).toEqual(["idx_email"]);
  });

  it("detects column-order change as modification", () => {
    const a = [idx({ name: "idx_compound", columns: ["a", "b"], unique: false })];
    const b = [idx({ name: "idx_compound", columns: ["b", "a"], unique: false })];
    const d = diffIndexes(a, b);
    expect(d.modified).toHaveLength(1);
    expect(d.modified[0]!.diffs[0]).toContain("columns: (a,b) → (b,a)");
  });

  it("detects unique-flag change", () => {
    const a = [idx({ name: "idx_x", columns: ["x"], unique: false })];
    const b = [idx({ name: "idx_x", columns: ["x"], unique: true })];
    const d = diffIndexes(a, b);
    expect(d.modified[0]!.diffs.some((s) => s.includes("unique"))).toBe(true);
  });
});

// ── diffForeignKeys ─────────────────────────────────────────────────

describe("diffForeignKeys", () => {
  const fk = (overrides: Partial<ForeignKey>): ForeignKey => ({
    name: "fk_user",
    columns: ["user_id"],
    referencedTable: "users",
    referencedColumns: ["id"],
    onUpdate: "RESTRICT",
    onDelete: "RESTRICT",
    ...overrides,
  });

  it("matches identical FK sets", () => {
    const d = diffForeignKeys([fk({})], [fk({})]);
    expect(d.modified).toEqual([]);
  });

  it("detects rename of referenced table", () => {
    const a = [fk({ name: "fk_x", referencedTable: "users" })];
    const b = [fk({ name: "fk_x", referencedTable: "people" })];
    const d = diffForeignKeys(a, b);
    expect(d.modified[0]!.diffs.some((s) => s.includes("references: users → people"))).toBe(true);
  });

  it("detects ON DELETE rule change", () => {
    const a = [fk({ name: "fk_x", onDelete: "RESTRICT" })];
    const b = [fk({ name: "fk_x", onDelete: "CASCADE" })];
    const d = diffForeignKeys(a, b);
    expect(d.modified[0]!.diffs.some((s) => s.includes("ON DELETE"))).toBe(true);
  });

  it("handles composite FK column changes", () => {
    const a = [fk({ name: "fk_c", columns: ["a", "b"], referencedColumns: ["x", "y"] })];
    const b = [fk({ name: "fk_c", columns: ["a", "c"], referencedColumns: ["x", "z"] })];
    const d = diffForeignKeys(a, b);
    expect(d.modified[0]!.diffs.length).toBe(2);
  });

  it("detects added FK", () => {
    const d = diffForeignKeys([], [fk({ name: "fk_new" })]);
    expect(d.onlyInTarget).toHaveLength(1);
    expect(d.onlyInSource).toEqual([]);
  });
});

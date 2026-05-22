import { describe, it, expect } from "vitest";
import {
  diffColumns,
  diffIndexes,
  diffForeignKeys,
  diffTableAttributes,
  diffViews,
  diffRoutines,
  diffTriggers,
  diffEvents,
  __test,
  type Column,
  type IndexDef,
  type ForeignKey,
  type TableAttributes,
  type View,
  type Routine,
  type Trigger,
  type Event,
} from "../tools/compare/index.js";

const { normalizeType, normalizeSQL, chunkArray } = __test;

// ── diffColumns ─────────────────────────────────────────────────────

describe("diffColumns", () => {
  const col = (overrides: Partial<Column>): Column => ({
    name: "id",
    type: "int(11)",
    nullable: false,
    default: null,
    key: "PRI",
    comment: "",
    extra: "",
    generationExpression: null,
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
    visible: true,
    subParts: [null],
    expressions: [null],
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

// ── diffTableAttributes ─────────────────────────────────────────────

describe("diffTableAttributes", () => {
  const attr = (overrides: Partial<TableAttributes>): TableAttributes => ({
    name: "users",
    engine: "InnoDB",
    charset: "utf8mb4",
    collation: "utf8mb4_0900_ai_ci",
    comment: "",
    rowFormat: "Dynamic",
    partitioned: false,
    partitionMethod: null,
    partitionExpression: null,
    partitionCount: 0,
    ...overrides,
  });

  it("detects engine drift (InnoDB vs MyISAM)", () => {
    const src = new Map([["t", attr({ name: "t", engine: "InnoDB" })]]);
    const tgt = new Map([["t", attr({ name: "t", engine: "MyISAM" })]]);
    const d = diffTableAttributes(src, tgt);
    expect(d.modified[0]!.diffs.some((s) => s.includes("engine: InnoDB → MyISAM"))).toBe(true);
  });

  it("detects new partitioning", () => {
    const src = new Map([["events", attr({ name: "events", partitioned: false })]]);
    const tgt = new Map([
      [
        "events",
        attr({
          name: "events",
          partitioned: true,
          partitionMethod: "RANGE",
          partitionExpression: "TO_DAYS(created_at)",
          partitionCount: 12,
        }),
      ],
    ]);
    const d = diffTableAttributes(src, tgt);
    expect(d.modified[0]!.diffs.some((s) => s.includes("partitioning: no → yes"))).toBe(true);
  });

  it("detects partition count drift on already-partitioned tables", () => {
    const base = attr({
      name: "events",
      partitioned: true,
      partitionMethod: "RANGE",
      partitionExpression: "TO_DAYS(d)",
      partitionCount: 12,
    });
    const src = new Map([["events", base]]);
    const tgt = new Map([["events", { ...base, partitionCount: 24 }]]);
    const d = diffTableAttributes(src, tgt);
    expect(d.modified[0]!.diffs.some((s) => s.includes("partition count: 12 → 24"))).toBe(true);
  });

  it("matches identical attrs", () => {
    const a = attr({});
    const d = diffTableAttributes(new Map([["t", a]]), new Map([["t", a]]));
    expect(d.modified).toEqual([]);
  });
});

// ── diffViews ───────────────────────────────────────────────────────

describe("diffViews", () => {
  const view = (overrides: Partial<View>): View => ({
    name: "active_users",
    definition: "SELECT * FROM users WHERE deleted_at IS NULL",
    updatable: true,
    securityType: "DEFINER",
    checkOption: "NONE",
    ...overrides,
  });

  it("ignores whitespace-only formatting differences", () => {
    const a = view({ definition: "SELECT  *\nFROM users" });
    const b = view({ definition: "SELECT * FROM users" });
    const d = diffViews([a], [b]);
    expect(d.modified).toEqual([]);
  });

  it("detects semantic body change", () => {
    const a = view({ definition: "SELECT id, name FROM users" });
    const b = view({ definition: "SELECT id, email FROM users" });
    const d = diffViews([a], [b]);
    expect(d.modified[0]!.diffs).toContain("definition changed");
  });

  it("detects security type change", () => {
    const a = view({ securityType: "DEFINER" });
    const b = view({ securityType: "INVOKER" });
    const d = diffViews([a], [b]);
    expect(d.modified[0]!.diffs.some((s) => s.startsWith("security:"))).toBe(true);
  });

  it("flags views only in source/target", () => {
    const d = diffViews([view({ name: "v1" })], [view({ name: "v2" })]);
    expect(d.onlyInSource.map((v) => v.name)).toEqual(["v1"]);
    expect(d.onlyInTarget.map((v) => v.name)).toEqual(["v2"]);
  });
});

// ── diffRoutines ────────────────────────────────────────────────────

describe("diffRoutines", () => {
  const routine = (overrides: Partial<Routine>): Routine => ({
    name: "calc_total",
    type: "FUNCTION",
    returnType: "decimal(10,2)",
    parameters: "IN user_id int",
    definition: "BEGIN RETURN 0; END",
    securityType: "DEFINER",
    deterministic: false,
    dataAccess: "READS SQL DATA",
    ...overrides,
  });

  it("detects parameter list change", () => {
    const a = routine({ parameters: "IN user_id int" });
    const b = routine({ parameters: "IN user_id int, IN year int" });
    const d = diffRoutines([a], [b]);
    expect(d.modified[0]!.diffs.some((s) => s.startsWith("parameters:"))).toBe(true);
  });

  it("detects body change (whitespace-insensitive)", () => {
    const a = routine({ definition: "BEGIN\n  RETURN 0;\nEND" });
    const b = routine({ definition: "BEGIN RETURN 0; END" });
    expect(diffRoutines([a], [b]).modified).toEqual([]);

    const c = routine({ definition: "BEGIN RETURN 1; END" });
    expect(diffRoutines([a], [c]).modified[0]!.diffs).toContain("body changed");
  });

  it("detects PROCEDURE ↔ FUNCTION change", () => {
    const a = routine({ type: "FUNCTION" });
    const b = routine({ type: "PROCEDURE" });
    const d = diffRoutines([a], [b]);
    expect(d.modified[0]!.diffs.some((s) => s.startsWith("type:"))).toBe(true);
  });
});

// ── diffTriggers ────────────────────────────────────────────────────

describe("diffTriggers", () => {
  const trig = (overrides: Partial<Trigger>): Trigger => ({
    name: "audit_users",
    table: "users",
    event: "INSERT",
    timing: "AFTER",
    orientation: "ROW",
    statement: "BEGIN INSERT INTO audit VALUES (NEW.id); END",
    ...overrides,
  });

  it("detects timing change (BEFORE vs AFTER)", () => {
    const a = trig({ timing: "BEFORE" });
    const b = trig({ timing: "AFTER" });
    const d = diffTriggers([a], [b]);
    expect(d.modified[0]!.diffs.some((s) => s.startsWith("timing:"))).toBe(true);
  });

  it("detects event change (INSERT vs UPDATE)", () => {
    const a = trig({ event: "INSERT" });
    const b = trig({ event: "UPDATE" });
    const d = diffTriggers([a], [b]);
    expect(d.modified[0]!.diffs.some((s) => s.startsWith("event:"))).toBe(true);
  });

  it("detects added trigger", () => {
    const d = diffTriggers([], [trig({})]);
    expect(d.onlyInTarget).toHaveLength(1);
  });
});

// ── diffEvents ──────────────────────────────────────────────────────

describe("diffEvents", () => {
  const ev = (overrides: Partial<Event>): Event => ({
    name: "nightly_cleanup",
    type: "RECURRING",
    intervalValue: "1",
    intervalField: "DAY",
    status: "ENABLED",
    starts: "2026-01-01 00:00:00",
    ends: null,
    definition: "DELETE FROM logs WHERE created_at < NOW() - INTERVAL 30 DAY",
    ...overrides,
  });

  it("detects status flip (ENABLED → DISABLED)", () => {
    const a = ev({ status: "ENABLED" });
    const b = ev({ status: "DISABLED" });
    const d = diffEvents([a], [b]);
    expect(d.modified[0]!.diffs.some((s) => s.startsWith("status:"))).toBe(true);
  });

  it("detects interval change", () => {
    const a = ev({ intervalValue: "1", intervalField: "DAY" });
    const b = ev({ intervalValue: "12", intervalField: "HOUR" });
    const d = diffEvents([a], [b]);
    expect(d.modified[0]!.diffs.some((s) => s.startsWith("interval:"))).toBe(true);
  });
});

// ── normalizeType ───────────────────────────────────────────────────

describe("normalizeType (MySQL 5.7 ↔ 8.0+ semantic equivalence)", () => {
  it("strips display widths from int family", () => {
    expect(normalizeType("int(11)")).toBe("int");
    expect(normalizeType("bigint(20)")).toBe("bigint");
    expect(normalizeType("smallint(6)")).toBe("smallint");
    expect(normalizeType("mediumint(9)")).toBe("mediumint");
    expect(normalizeType("tinyint(4)")).toBe("tinyint");
  });

  it("preserves tinyint(1) as the boolean idiom", () => {
    expect(normalizeType("tinyint(1)")).toBe("tinyint(1)");
  });

  it("preserves varchar/char/decimal widths (semantically meaningful)", () => {
    expect(normalizeType("varchar(255)")).toBe("varchar(255)");
    expect(normalizeType("char(10)")).toBe("char(10)");
    expect(normalizeType("decimal(10,2)")).toBe("decimal(10,2)");
  });

  it("handles unsigned / zerofill modifiers", () => {
    expect(normalizeType("int(10) unsigned")).toBe("int unsigned");
    expect(normalizeType("BIGINT(20) UNSIGNED")).toBe("bigint unsigned");
  });

  it("masks varchar(20) → varchar(50) drift correctly (no normalization)", () => {
    // Sanity that we're not over-normalizing
    expect(normalizeType("varchar(20)")).not.toBe(normalizeType("varchar(50)"));
  });
});

// ── normalizeSQL ────────────────────────────────────────────────────

describe("normalizeSQL", () => {
  it("collapses whitespace", () => {
    expect(normalizeSQL("SELECT  *\n  FROM users")).toBe("SELECT * FROM users");
  });

  it("trims leading/trailing whitespace", () => {
    expect(normalizeSQL("  SELECT 1  ")).toBe("SELECT 1");
  });

  it("returns empty string for null/undefined", () => {
    expect(normalizeSQL(null)).toBe("");
    expect(normalizeSQL(undefined)).toBe("");
  });
});

// ── chunkArray ──────────────────────────────────────────────────────

describe("chunkArray (IN-list chunking for huge schemas)", () => {
  it("returns the input as a single chunk when under threshold", () => {
    expect(chunkArray([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
  });

  it("splits into equal-sized chunks plus tail", () => {
    const arr = Array.from({ length: 1003 }, (_, i) => i);
    const chunks = chunkArray(arr, 500);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[1]).toHaveLength(500);
    expect(chunks[2]).toHaveLength(3);
  });

  it("handles empty input", () => {
    expect(chunkArray([], 500)).toEqual([[]]);
  });
});

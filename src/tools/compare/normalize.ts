import type { BaseDiff } from "../../types/db.js";
import { COMPARE_CHUNK_SIZE } from "../../limits.js";

/**
 * Normalization + small utilities shared across compare phases.
 *
 * Pure functions — no DB access, no logging. Keep it that way so the
 * unit tests stay trivial.
 */

/** Emit `?,?,?` for an IN-list of `values.length` placeholders. */
export function inListPlaceholders(values: string[]): string {
  return values.map(() => "?").join(",");
}

/**
 * Slice a list into chunks. Used to keep IN-list queries below the
 * server's max_allowed_packet on huge schemas. See COMPARE_CHUNK_SIZE
 * in src/limits.ts for the default size rationale.
 */
export function chunkArray<T>(arr: T[], size = COMPARE_CHUNK_SIZE): T[][] {
  if (arr.length <= size) return [arr];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/**
 * Strip MySQL display widths from integer-family types — `int(11)` was
 * cosmetic and removed in MySQL 8.0.17. Preserves `tinyint(1)` because
 * that's the canonical boolean convention and remains meaningful.
 */
export function normalizeType(t: string): string {
  if (/^tinyint\(1\)$/i.test(t)) return t.toLowerCase();
  return t.replace(
    /^(tinyint|smallint|mediumint|int|bigint)\(\d+\)(\s+unsigned)?(\s+zerofill)?$/i,
    (_m, base, unsigned, zerofill) =>
      `${base}${unsigned ?? ""}${zerofill ?? ""}`.toLowerCase(),
  );
}

/**
 * Normalize SQL bodies (view/routine/trigger/event definitions) for
 * comparison. Different servers may render the same logical body with
 * different whitespace, so we collapse it. Definers are already stripped
 * by selecting from the ROUTINE_DEFINITION / VIEW_DEFINITION columns
 * (those return the body without the wrapping CREATE clause).
 */
export function normalizeSQL(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

export function formatDefault(d: string | null): string {
  if (d === null) return "NULL";
  return `'${d}'`;
}

export function subPartString(parts: Array<number | null>): string {
  return parts.map((p) => (p === null ? "full" : String(p))).join(",");
}

export function sumAcross<T>(
  map: Map<string, T>,
  pick: (v: T) => number,
): number {
  let total = 0;
  for (const v of map.values()) total += pick(v);
  return total;
}

export function emptyDiff<T>(): BaseDiff<T> {
  return { onlyInSource: [], onlyInTarget: [], modified: [] };
}

export function diffHasContent(d: BaseDiff<unknown>): boolean {
  return (
    d.onlyInSource.length > 0 ||
    d.onlyInTarget.length > 0 ||
    d.modified.length > 0
  );
}

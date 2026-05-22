import { MAX_COL_WIDTH, MAX_OUTPUT_BYTES } from "./limits.js";

/**
 * Output formatting helpers — rendering query results as text tables
 * and human-readable byte sizes.
 *
 * Keep this module display-only: no DB access, no logging, no MCP
 * types. It's pure transformation so it stays trivially testable.
 */

export function formatAsTable(
  rows: ReadonlyArray<object>,
  opts?: { maxWidth?: number; maxBytes?: number },
): string {
  const firstRow = rows[0];
  if (firstRow === undefined) return "(empty)";

  const maxW = opts?.maxWidth ?? MAX_COL_WIDTH;
  const maxBytes = opts?.maxBytes ?? MAX_OUTPUT_BYTES;
  const keys = Object.keys(firstRow);
  // Internal-only narrowing: every row is treated as a plain
  // string→unknown bag so we can read by column name.
  const readKey = (row: object, key: string): unknown =>
    (row as Record<string, unknown>)[key];

  const truncate = (val: unknown): string => {
    if (val == null) return "NULL";
    let s: string;
    // BLOB / BINARY columns come back as Buffer (Uint8Array). Rendering
    // them as raw bytes either pollutes the output with garbage UTF-8
    // or balloons the payload. Show size-only metadata.
    if (val instanceof Uint8Array) {
      s = `<Buffer ${val.length} bytes>`;
    } else if (typeof val === "object" && !(val instanceof Date)) {
      // mysql2 returns JSON columns as parsed objects/arrays; String(obj)
      // gives "[object Object]". JSON.stringify preserves structure.
      try {
        s = JSON.stringify(val);
      } catch {
        s = String(val);
      }
    } else {
      s = String(val);
    }
    if (s.length <= maxW) return s;
    return s.slice(0, maxW - 3) + "...";
  };

  const widths = keys.map((k) =>
    Math.min(maxW, Math.max(k.length, ...rows.map((r) => truncate(readKey(r, k)).length))),
  );

  const header = keys.map((k, i) => k.padEnd(widths[i] ?? 0)).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");

  // Build rows incrementally and stop once we'd exceed the byte budget.
  // Prevents any single over-wide table from tanking the upstream request.
  const body: string[] = [];
  let bytesUsed =
    Buffer.byteLength(header, "utf8") +
    1 +
    Buffer.byteLength(separator, "utf8") +
    1;
  let omitted = 0;
  for (const row of rows) {
    const line = keys
      .map((k, i) => truncate(readKey(row, k)).padEnd(widths[i] ?? 0))
      .join(" | ");
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytesUsed + lineBytes > maxBytes) {
      omitted = rows.length - body.length;
      break;
    }
    body.push(line);
    bytesUsed += lineBytes;
  }

  const out = [header, separator, ...body].join("\n");
  if (omitted > 0) {
    return (
      out +
      `\n... (truncated — ${omitted} more row(s) omitted to keep output under ${Math.floor(maxBytes / 1024)}KB)`
    );
  }
  return out;
}

export function humanSize(bytes: number | null | undefined): string {
  if (bytes == null) return "N/A";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

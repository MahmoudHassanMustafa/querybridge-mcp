/**
 * SQL identifier escaping.
 *
 * Values go through `?` placeholders; identifiers (table, column, db
 * names) cannot, so they go through these helpers. Never interpolate
 * an identifier into a SQL string without `escapeId` first — that's
 * how SQL injection sneaks back in when you "just" need a dynamic
 * table name.
 */

export function escapeId(name: string): string {
  if (name.length === 0) {
    throw new Error("Identifier cannot be empty");
  }
  if (name.length > 64) {
    throw new Error(
      `Identifier too long (max 64 chars): "${name.substring(0, 20)}..."`,
    );
  }
  if (name.includes("\0")) {
    throw new Error("Identifier cannot contain NUL bytes");
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

export function qualifiedTable(db: string, table: string): string {
  return `${escapeId(db)}.${escapeId(table)}`;
}

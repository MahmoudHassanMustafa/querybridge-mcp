/**
 * Read-only query gatekeeping.
 *
 * `isReadOnlyQuery` and `isExplainSafe` are the only places that decide
 * "can this SQL run on a readonly connection?" — bypassing them lets
 * `WITH cte AS (SELECT 1) DELETE …` through. Comments are stripped
 * first so they cannot be used to hide a write keyword from the regex.
 */

/**
 * Strip SQL comments so they cannot mask write keywords. Handles block
 * comments and both flavours of line comment (-- and #).
 */
export function stripSQLComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " ") // -- line comments
    .replace(/#[^\n]*/g, " ") // # line comments
    .trim();
}

/**
 * Keywords that indicate a write/mutating operation. Used to reject
 * dangerous queries even when they start with an allowed keyword like
 * WITH.
 */
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|RENAME|GRANT|REVOKE|LOCK|UNLOCK|CALL|SET|LOAD|DO|HANDLER|IMPORT|INSTALL|UNINSTALL|RESET|PURGE|PREPARE|EXECUTE|DEALLOCATE)\b/i;

/**
 * Block SELECT INTO OUTFILE/DUMPFILE — these are SELECTs that write
 * files to the server filesystem.
 */
const INTO_FILE_PATTERN = /\bINTO\s+(OUTFILE|DUMPFILE)\b/i;

/**
 * Whitelist approach: only allow known safe read-only statements.
 * Returns true if the query is safe for read-only connections.
 *
 * Rules:
 * - SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, USE are allowed
 * - SELECT INTO OUTFILE/DUMPFILE is blocked (writes files)
 * - WITH queries are allowed ONLY if they contain no write keywords
 *   (blocks WITH...INSERT, WITH...UPDATE, WITH...DELETE, etc.)
 */
export function isReadOnlyQuery(sql: string): boolean {
  const normalized = stripSQLComments(sql);

  if (INTO_FILE_PATTERN.test(normalized)) return false;

  if (/^(SHOW|DESCRIBE|DESC|EXPLAIN|USE)\b/i.test(normalized)) return true;

  if (/^SELECT\b/i.test(normalized)) return true;

  // WITH cte AS (SELECT 1) INSERT INTO … is a write disguised as a CTE.
  // We reject anything that contains a write keyword anywhere in the
  // statement. A false-positive edge case (WITH … WHERE col = 'DELETE')
  // is avoided by encouraging parameterized queries.
  if (/^WITH\b/i.test(normalized)) {
    return !WRITE_KEYWORDS.test(normalized);
  }

  return false;
}

/**
 * Validate that a query is safe for EXPLAIN: SELECT only, no write
 * side-effects.
 */
export function isExplainSafe(sql: string): boolean {
  const normalized = stripSQLComments(sql);

  if (INTO_FILE_PATTERN.test(normalized)) return false;

  if (/^SELECT\b/i.test(normalized)) return true;

  if (/^WITH\b/i.test(normalized)) {
    return !WRITE_KEYWORDS.test(normalized);
  }

  return false;
}

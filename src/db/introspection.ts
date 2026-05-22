import { queryWithTimeout } from "../connection.js";
import { qualifiedTable, escapeId } from "../sql/identifiers.js";

/**
 * `information_schema` and `SHOW`-family queries every tool can call.
 *
 * Two responsibilities:
 *   1. Dedup SQL that more than one caller needs (the original reason).
 *   2. Act as the **unit-test seam** — every information_schema read a
 *      tool performs goes through this module, so mocking
 *      `queryWithTimeout` (via `registerMockConnection`) is enough to
 *      drive any handler in a test without testcontainers.
 *
 * Functions here:
 *   - Return normalized typed rows, never `Record<string, unknown>`.
 *   - Take `(connection, …)` so call sites stay shape-stable.
 *   - Stay pure SQL + row mapping; no rendering, no toolError.
 */

/**
 * List the names of every database visible to this connection. Run
 * via `SHOW DATABASES` so the access-control filter MySQL applies on
 * the connection's user is respected.
 *
 * Used by `list_databases`, the resource autocomplete handlers, and
 * the resource listing — three identical SHOW DATABASES sites before
 * extraction.
 */
export async function listDatabaseNames(connection: string): Promise<string[]> {
  // SHOW DATABASES returns a single column whose name (`Database`)
  // depends on the server version — read the first column by index
  // to stay version-agnostic.
  const rows = await queryWithTimeout<Array<Record<string, string>>>(
    connection,
    "SHOW DATABASES",
  );
  return rows
    .map((r) => Object.values(r)[0])
    .filter((v): v is string => typeof v === "string");
}

/**
 * List the names of every base table in `db`. Used by the compare
 * orchestrator, the table-schema resource listing, and the
 * resource autocomplete handler — all three asked for exactly this
 * before the extraction.
 */
export async function listTableNames(
  connection: string,
  db: string,
): Promise<string[]> {
  const rows = await queryWithTimeout<Array<{ TABLE_NAME: string }>>(
    connection,
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
    [db],
  );
  return rows.map((r) => r.TABLE_NAME);
}

/**
 * Return the body of `SHOW CREATE TABLE <db>.<table>`. Returns an
 * empty string if the table is missing or is actually a view (callers
 * that need to distinguish those cases should fetch the row directly
 * with `getCreateTableRaw`).
 */
export async function getCreateTable(
  connection: string,
  db: string,
  table: string,
): Promise<string> {
  const rows = await queryWithTimeout<Array<Record<string, string>>>(
    connection,
    `SHOW CREATE TABLE ${qualifiedTable(db, table)}`,
  );
  return rows[0]?.["Create Table"] ?? "";
}

/**
 * Raw `SHOW CREATE TABLE` row — exposes both "Create Table" and
 * "Create View" so describe_table can detect when the user pointed at
 * a view and produce a useful hint.
 */
export async function getCreateTableRaw(
  connection: string,
  db: string,
  table: string,
): Promise<Record<string, string> | undefined> {
  const rows = await queryWithTimeout<Array<Record<string, string>>>(
    connection,
    `SHOW CREATE TABLE ${qualifiedTable(db, table)}`,
  );
  return rows[0];
}

// ── Tables ────────────────────────────────────────────────────────

export interface TableListRow {
  TABLE_NAME: string;
  TABLE_ROWS: number | null;
  ENGINE: string | null;
  TABLE_COMMENT: string | null;
}

/** List base tables with row count, engine, and comment — for `list_tables`. */
export async function listTablesDetailed(
  connection: string,
  db: string,
): Promise<TableListRow[]> {
  return queryWithTimeout<TableListRow[]>(
    connection,
    `SELECT TABLE_NAME, TABLE_ROWS, ENGINE, TABLE_COMMENT
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [db],
  );
}

export interface TableStatsRow {
  TABLE_NAME: string;
  TABLE_ROWS: number | null;
  DATA_LENGTH: number | null;
  INDEX_LENGTH: number | null;
  AUTO_INCREMENT: number | null;
  CREATE_TIME: string | null;
  UPDATE_TIME: string | null;
  ENGINE: string | null;
}

/** Row counts + data/index sizes + auto-increment — for `get_table_stats`. */
export async function getTableStats(
  connection: string,
  db: string,
  table?: string,
): Promise<TableStatsRow[]> {
  let sql = `
    SELECT
      TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH,
      AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME, ENGINE
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`;
  const params: string[] = [db];
  if (table) {
    sql += ` AND TABLE_NAME = ?`;
    params.push(table);
  }
  sql += ` ORDER BY DATA_LENGTH DESC`;
  return queryWithTimeout<TableStatsRow[]>(connection, sql, params);
}

// ── DESCRIBE / SHOW INDEX ─────────────────────────────────────────

export interface DescribeColumnRow {
  Field: string;
  Type: string;
  Null: "YES" | "NO";
  Key: string;
  Default: string | null;
  Extra: string;
}

export interface ShowIndexRow {
  Table: string;
  Non_unique: number;
  Key_name: string;
  Seq_in_index: number;
  Column_name: string | null;
  Collation: string | null;
  Cardinality: number | null;
  Sub_part: number | null;
  Packed: string | null;
  Null: string;
  Index_type: string;
  Comment: string;
  Index_comment: string;
  Visible?: string;
  Expression?: string | null;
}

/** `DESCRIBE <db>.<table>` — column-by-column shape from MySQL's POV. */
export async function describeTableColumns(
  connection: string,
  db: string,
  table: string,
): Promise<DescribeColumnRow[]> {
  return queryWithTimeout<DescribeColumnRow[]>(
    connection,
    `DESCRIBE ${qualifiedTable(db, table)}`,
  );
}

/** `SHOW INDEX FROM <db>.<table>` — per-key-part row, not one-row-per-index. */
export async function showIndexes(
  connection: string,
  db: string,
  table: string,
): Promise<ShowIndexRow[]> {
  return queryWithTimeout<ShowIndexRow[]>(
    connection,
    `SHOW INDEX FROM ${qualifiedTable(db, table)}`,
  );
}

// ── Foreign keys ─────────────────────────────────────────────────

export interface ForeignKeyRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_SCHEMA: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  UPDATE_RULE: string;
  DELETE_RULE: string;
}

/** FK list for one table or the whole schema — used by `get_foreign_keys`. */
export async function getForeignKeys(
  connection: string,
  db: string,
  table?: string,
): Promise<ForeignKeyRow[]> {
  let sql = `
    SELECT
      kcu.TABLE_NAME, kcu.COLUMN_NAME,
      kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME,
      kcu.REFERENCED_COLUMN_NAME,
      rc.UPDATE_RULE, rc.DELETE_RULE
    FROM information_schema.KEY_COLUMN_USAGE kcu
    JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
      ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
      AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
    WHERE kcu.TABLE_SCHEMA = ?
      AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`;
  const params: string[] = [db];
  if (table) {
    sql += ` AND kcu.TABLE_NAME = ?`;
    params.push(table);
  }
  sql += ` ORDER BY kcu.TABLE_NAME, kcu.ORDINAL_POSITION`;
  return queryWithTimeout<ForeignKeyRow[]>(connection, sql, params);
}

// ── Indexes (information_schema.STATISTICS) ──────────────────────

export interface IndexStatsRow {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: number;
  SEQ_IN_INDEX: number;
  COLUMN_NAME: string;
  CARDINALITY: number | null;
  INDEX_TYPE: string;
}

/** Per-key-part index rows — `get_indexes` regroups by `(table, index)`. */
export async function getIndexStats(
  connection: string,
  db: string,
  table?: string,
): Promise<IndexStatsRow[]> {
  let sql = `
    SELECT
      TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX,
      COLUMN_NAME, CARDINALITY, INDEX_TYPE
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ?`;
  const params: string[] = [db];
  if (table) {
    sql += ` AND TABLE_NAME = ?`;
    params.push(table);
  }
  sql += ` ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`;
  return queryWithTimeout<IndexStatsRow[]>(connection, sql, params);
}

// ── Columns ──────────────────────────────────────────────────────

export interface ColumnSearchRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: "YES" | "NO";
  COLUMN_KEY: string;
  COLUMN_DEFAULT: string | null;
}

/** Cross-table LIKE search for `search_columns`. */
export async function searchColumns(
  connection: string,
  db: string,
  pattern: string,
): Promise<ColumnSearchRow[]> {
  return queryWithTimeout<ColumnSearchRow[]>(
    connection,
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND COLUMN_NAME LIKE ?
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [db, pattern],
  );
}

// ── Views ────────────────────────────────────────────────────────

export interface ViewListRow {
  TABLE_NAME: string;
  IS_UPDATABLE: "YES" | "NO";
  DEFINER: string;
  SECURITY_TYPE: string;
  CHECK_OPTION: string;
}

/** Brief view list for `list_views`. */
export async function listViewsBrief(
  connection: string,
  db: string,
): Promise<ViewListRow[]> {
  return queryWithTimeout<ViewListRow[]>(
    connection,
    `SELECT TABLE_NAME, IS_UPDATABLE, DEFINER, SECURITY_TYPE, CHECK_OPTION
     FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME`,
    [db],
  );
}

/** Body of `SHOW CREATE VIEW`. Returns empty string if absent. */
export async function getViewDdl(
  connection: string,
  db: string,
  view: string,
): Promise<string> {
  const rows = await queryWithTimeout<Array<Record<string, string>>>(
    connection,
    `SHOW CREATE VIEW ${qualifiedTable(db, view)}`,
  );
  return rows[0]?.["Create View"] ?? "";
}

// ── Routines (procedures + functions) ────────────────────────────

export interface RoutineListRow {
  ROUTINE_NAME: string;
  ROUTINE_TYPE: "PROCEDURE" | "FUNCTION";
  RETURN_TYPE: string | null;
  ROUTINE_COMMENT: string | null;
  DEFINER: string;
  CREATED: string | null;
  LAST_ALTERED: string | null;
  SECURITY_TYPE: string;
}

/** Brief routine list, optionally narrowed by type — for `list_routines`. */
export async function listRoutinesBrief(
  connection: string,
  db: string,
  type: "PROCEDURE" | "FUNCTION" | "ALL" = "ALL",
): Promise<RoutineListRow[]> {
  let sql = `
    SELECT
      ROUTINE_NAME, ROUTINE_TYPE,
      DTD_IDENTIFIER AS RETURN_TYPE,
      ROUTINE_COMMENT, DEFINER, CREATED, LAST_ALTERED, SECURITY_TYPE
    FROM information_schema.ROUTINES
    WHERE ROUTINE_SCHEMA = ?`;
  const params: string[] = [db];
  if (type !== "ALL") {
    sql += ` AND ROUTINE_TYPE = ?`;
    params.push(type);
  }
  sql += ` ORDER BY ROUTINE_TYPE, ROUTINE_NAME`;
  return queryWithTimeout<RoutineListRow[]>(connection, sql, params);
}

/**
 * Detect whether a routine exists, and if so what type it is. Used
 * by `get_routine_ddl` to auto-detect `PROCEDURE` vs `FUNCTION` when
 * the caller didn't specify.
 */
export async function findRoutineType(
  connection: string,
  db: string,
  name: string,
): Promise<"PROCEDURE" | "FUNCTION" | null> {
  const rows = await queryWithTimeout<
    Array<{ ROUTINE_TYPE: "PROCEDURE" | "FUNCTION" }>
  >(
    connection,
    `SELECT ROUTINE_TYPE FROM information_schema.ROUTINES
     WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ?`,
    [db, name],
  );
  return rows[0]?.ROUTINE_TYPE ?? null;
}

/**
 * Body of `SHOW CREATE PROCEDURE/FUNCTION`. Column name varies by
 * routine type (`Create Procedure` vs `Create Function`) so the
 * caller passes the type to pick the right column.
 */
export async function getRoutineDdl(
  connection: string,
  db: string,
  type: "PROCEDURE" | "FUNCTION",
  name: string,
): Promise<string> {
  const rows = await queryWithTimeout<Array<Record<string, string>>>(
    connection,
    // `type` is a TypeScript literal-union "PROCEDURE" | "FUNCTION";
    // MySQL refuses `?` placeholders for the routine kind, so direct
    // interpolation is unavoidable. db/name go through escapeId.
    // eslint-disable-next-line no-restricted-syntax
    `SHOW CREATE ${type} ${escapeId(db)}.${escapeId(name)}`,
  );
  const key = type === "PROCEDURE" ? "Create Procedure" : "Create Function";
  return rows[0]?.[key] ?? "";
}

// ── Triggers ─────────────────────────────────────────────────────

export interface TriggerListRow {
  TRIGGER_NAME: string;
  EVENT: string;
  TIMING: string;
  TABLE_NAME: string;
  ACTION_ORIENTATION: string;
  DEFINER: string;
  CREATED: string | null;
}

/** Trigger list for `list_triggers`. */
export async function listTriggersBrief(
  connection: string,
  db: string,
  table?: string,
): Promise<TriggerListRow[]> {
  let sql = `
    SELECT
      TRIGGER_NAME,
      EVENT_MANIPULATION AS EVENT,
      ACTION_TIMING AS TIMING,
      EVENT_OBJECT_TABLE AS TABLE_NAME,
      ACTION_ORIENTATION,
      DEFINER,
      CREATED
    FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA = ?`;
  const params: string[] = [db];
  if (table) {
    sql += ` AND EVENT_OBJECT_TABLE = ?`;
    params.push(table);
  }
  sql += ` ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION`;
  return queryWithTimeout<TriggerListRow[]>(connection, sql, params);
}

/** Body of `SHOW CREATE TRIGGER`. */
export async function getTriggerDdl(
  connection: string,
  db: string,
  name: string,
): Promise<string> {
  const rows = await queryWithTimeout<Array<Record<string, string>>>(
    connection,
    `SHOW CREATE TRIGGER ${escapeId(db)}.${escapeId(name)}`,
  );
  return rows[0]?.["SQL Original Statement"] ?? "";
}

// ── Events ───────────────────────────────────────────────────────

export interface EventListRow {
  EVENT_NAME: string;
  EVENT_TYPE: string;
  INTERVAL_VALUE: string | null;
  INTERVAL_FIELD: string | null;
  STATUS: string;
  STARTS: string | null;
  ENDS: string | null;
  LAST_EXECUTED: string | null;
  DEFINER: string;
}

/** Event list for `list_events`. */
export async function listEventsBrief(
  connection: string,
  db: string,
): Promise<EventListRow[]> {
  return queryWithTimeout<EventListRow[]>(
    connection,
    `SELECT EVENT_NAME, EVENT_TYPE, INTERVAL_VALUE, INTERVAL_FIELD,
            STATUS, STARTS, ENDS, LAST_EXECUTED, DEFINER
     FROM information_schema.EVENTS
     WHERE EVENT_SCHEMA = ?
     ORDER BY EVENT_NAME`,
    [db],
  );
}

/** Body of `SHOW CREATE EVENT`. */
export async function getEventDdl(
  connection: string,
  db: string,
  name: string,
): Promise<string> {
  const rows = await queryWithTimeout<Array<Record<string, string>>>(
    connection,
    `SHOW CREATE EVENT ${escapeId(db)}.${escapeId(name)}`,
  );
  return rows[0]?.["Create Event"] ?? "";
}

// ── Process list / unused indexes / charset ──────────────────────

export interface ProcessRow {
  ID: number;
  USER: string;
  HOST: string;
  DB: string | null;
  COMMAND: string;
  TIME: number;
  STATE: string | null;
  QUERY: string | null;
}

/** Active non-sleep MySQL threads — for `list_processes`. */
export async function getProcessList(
  connection: string,
  minSeconds?: number,
): Promise<ProcessRow[]> {
  let sql = `
    SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO AS QUERY
    FROM information_schema.PROCESSLIST
    WHERE COMMAND != 'Sleep'`;
  const params: unknown[] = [];
  if (minSeconds != null) {
    sql += ` AND TIME >= ?`;
    params.push(minSeconds);
  }
  sql += ` ORDER BY TIME DESC`;
  return queryWithTimeout<ProcessRow[]>(connection, sql, params);
}

export interface UnusedIndexRow {
  database: string;
  table: string;
  index: string;
  access_count: number;
}

/**
 * Secondary indexes with zero recorded reads since server start, from
 * `performance_schema`. Excludes PRIMARY because dropping the PK is
 * almost never what the operator wants.
 */
export async function getUnusedIndexes(
  connection: string,
  db: string,
): Promise<UnusedIndexRow[]> {
  return queryWithTimeout<UnusedIndexRow[]>(
    connection,
    `SELECT
       OBJECT_SCHEMA AS \`database\`,
       OBJECT_NAME   AS \`table\`,
       INDEX_NAME    AS \`index\`,
       COUNT_STAR    AS access_count
     FROM performance_schema.table_io_waits_summary_by_index_usage
     WHERE OBJECT_SCHEMA = ?
       AND INDEX_NAME IS NOT NULL
       AND INDEX_NAME != 'PRIMARY'
       AND COUNT_STAR = 0
     ORDER BY OBJECT_NAME, INDEX_NAME`,
    [db],
  );
}

export interface DatabaseCharsetRow {
  SCHEMA_NAME: string;
  charset: string;
  collation: string;
}

export interface TableCharsetRow {
  TABLE_NAME: string;
  collation: string | null;
  charset: string | null;
}

export interface ColumnCharsetRow {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  charset: string | null;
  collation: string | null;
}

export interface CharsetCollationInfo {
  databaseInfo: DatabaseCharsetRow[];
  tableInfo: TableCharsetRow[];
  columns: ColumnCharsetRow[];
}

/**
 * Charset + collation breakdown at database, table, and column levels.
 * Table and column sections come back empty when `table` is omitted.
 */
export async function getCharsetCollation(
  connection: string,
  db: string,
  table?: string,
): Promise<CharsetCollationInfo> {
  const databaseInfo = await queryWithTimeout<DatabaseCharsetRow[]>(
    connection,
    `SELECT SCHEMA_NAME,
            DEFAULT_CHARACTER_SET_NAME AS charset,
            DEFAULT_COLLATION_NAME    AS collation
     FROM information_schema.SCHEMATA
     WHERE SCHEMA_NAME = ?`,
    [db],
  );

  if (!table) {
    return { databaseInfo, tableInfo: [], columns: [] };
  }

  const tableInfo = await queryWithTimeout<TableCharsetRow[]>(
    connection,
    `SELECT TABLE_NAME, TABLE_COLLATION AS collation,
            (SELECT CHARACTER_SET_NAME
             FROM information_schema.COLLATIONS
             WHERE COLLATION_NAME = t.TABLE_COLLATION) AS charset
     FROM information_schema.TABLES t
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table],
  );

  const columns = await queryWithTimeout<ColumnCharsetRow[]>(
    connection,
    `SELECT COLUMN_NAME, COLUMN_TYPE,
            CHARACTER_SET_NAME AS charset,
            COLLATION_NAME    AS collation
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
       AND CHARACTER_SET_NAME IS NOT NULL
     ORDER BY ORDINAL_POSITION`,
    [db, table],
  );

  return { databaseInfo, tableInfo, columns };
}

/** Check whether a database exists (used by `use_database`). */
export async function databaseExists(
  connection: string,
  name: string,
): Promise<boolean> {
  const rows = await queryWithTimeout<unknown[]>(
    connection,
    "SHOW DATABASES LIKE ?",
    [name],
  );
  return rows.length > 0;
}

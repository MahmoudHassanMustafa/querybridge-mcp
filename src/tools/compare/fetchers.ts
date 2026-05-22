import { queryWithTimeout } from "../../connection.js";
import { listTableNames } from "../../db/introspection.js";
import type {
  Column,
  IndexDef,
  ForeignKey,
  TableAttributes,
  View,
  Routine,
  Trigger,
  Event,
} from "../../types/db.js";
import { chunkArray, inListPlaceholders } from "./normalize.js";

/** Re-exported so the orchestrator keeps one consistent fetcher surface. */
export { listTableNames as listTables };

/**
 * Fetchers: pull normalized domain objects from information_schema.
 *
 * Each `listX` function takes a connection + database (+ table list
 * where relevant) and returns the normalized shape from types/db.ts —
 * never raw rows. The compare orchestrator and the renderer never
 * touch information_schema directly; they stay shape-stable.
 *
 * Bulk lookups (per-table column / index / FK loads) are chunked to
 * keep IN-list queries below `max_allowed_packet` on huge schemas.
 */

export async function listTableAttributes(
  connection: string,
  db: string,
  tables: string[],
): Promise<Map<string, TableAttributes>> {
  const out = new Map<string, TableAttributes>();
  for (const chunk of chunkArray(tables)) {
    const rows = await queryWithTimeout<
      Array<{
        TABLE_NAME: string;
        ENGINE: string | null;
        TABLE_COLLATION: string | null;
        TABLE_COMMENT: string | null;
        ROW_FORMAT: string | null;
        CREATE_OPTIONS: string | null;
      }>
    >(
      connection,
      `SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_COMMENT, ROW_FORMAT, CREATE_OPTIONS
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME IN (${inListPlaceholders(chunk)})`,
      [db, ...chunk],
    );
    const collationByTable = new Map(
      rows.map((r) => [r.TABLE_NAME, r.TABLE_COLLATION ?? ""]),
    );
    const charsetByCollation = await collationCharsetMap(connection, [
      ...new Set([...collationByTable.values()].filter(Boolean)),
    ]);
    // Partitioning is in a separate table.
    const partRows = await queryWithTimeout<
      Array<{
        TABLE_NAME: string;
        PARTITION_METHOD: string | null;
        PARTITION_EXPRESSION: string | null;
        PARTITIONS: number;
      }>
    >(
      connection,
      `SELECT TABLE_NAME,
              MAX(PARTITION_METHOD)     AS PARTITION_METHOD,
              MAX(PARTITION_EXPRESSION) AS PARTITION_EXPRESSION,
              COUNT(*)                  AS PARTITIONS
       FROM information_schema.PARTITIONS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME IN (${inListPlaceholders(chunk)})
         AND PARTITION_NAME IS NOT NULL
       GROUP BY TABLE_NAME`,
      [db, ...chunk],
    );
    const partsByTable = new Map(partRows.map((r) => [r.TABLE_NAME, r]));

    for (const r of rows) {
      const collation = r.TABLE_COLLATION ?? "";
      const part = partsByTable.get(r.TABLE_NAME);
      out.set(r.TABLE_NAME, {
        name: r.TABLE_NAME,
        engine: r.ENGINE ?? "",
        charset: charsetByCollation.get(collation) ?? "",
        collation,
        comment: r.TABLE_COMMENT ?? "",
        rowFormat: r.ROW_FORMAT ?? "",
        partitioned: Boolean(part),
        partitionMethod: part?.PARTITION_METHOD ?? null,
        partitionExpression: part?.PARTITION_EXPRESSION ?? null,
        partitionCount: part?.PARTITIONS ?? 0,
      });
    }
  }
  return out;
}

async function collationCharsetMap(
  connection: string,
  collations: string[],
): Promise<Map<string, string>> {
  if (collations.length === 0) return new Map();
  const rows = await queryWithTimeout<
    Array<{ COLLATION_NAME: string; CHARACTER_SET_NAME: string }>
  >(
    connection,
    `SELECT COLLATION_NAME, CHARACTER_SET_NAME
     FROM information_schema.COLLATIONS
     WHERE COLLATION_NAME IN (${inListPlaceholders(collations)})`,
    collations,
  );
  return new Map(rows.map((r) => [r.COLLATION_NAME, r.CHARACTER_SET_NAME]));
}

export async function listColumns(
  connection: string,
  db: string,
  tables: string[],
): Promise<Map<string, Column[]>> {
  const byTable = new Map<string, Column[]>();
  for (const chunk of chunkArray(tables)) {
    const rows = await queryWithTimeout<
      Array<{
        TABLE_NAME: string;
        COLUMN_NAME: string;
        COLUMN_TYPE: string;
        IS_NULLABLE: string;
        COLUMN_DEFAULT: string | null;
        COLUMN_KEY: string;
        COLUMN_COMMENT: string | null;
        EXTRA: string | null;
        GENERATION_EXPRESSION: string | null;
        ORDINAL_POSITION: number;
      }>
    >(
      connection,
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
              COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT, EXTRA,
              GENERATION_EXPRESSION, ORDINAL_POSITION
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME IN (${inListPlaceholders(chunk)})
       ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [db, ...chunk],
    );
    for (const r of rows) {
      const arr = byTable.get(r.TABLE_NAME) ?? [];
      arr.push({
        name: r.COLUMN_NAME,
        type: r.COLUMN_TYPE,
        nullable: r.IS_NULLABLE === "YES",
        default: r.COLUMN_DEFAULT,
        key: r.COLUMN_KEY,
        comment: r.COLUMN_COMMENT ?? "",
        extra: r.EXTRA ?? "",
        generationExpression: r.GENERATION_EXPRESSION || null,
      });
      byTable.set(r.TABLE_NAME, arr);
    }
  }
  return byTable;
}

export async function listIndexes(
  connection: string,
  db: string,
  tables: string[],
): Promise<Map<string, IndexDef[]>> {
  const acc = new Map<string, Map<string, IndexDef>>();
  for (const chunk of chunkArray(tables)) {
    // EXPRESSION + IS_VISIBLE are MySQL 8 additions; on older servers
    // these columns may not exist. Use a defensive SELECT that includes
    // them and trust the driver to return undefined for unknown columns.
    const rows = await queryWithTimeout<
      Array<{
        TABLE_NAME: string;
        INDEX_NAME: string;
        SEQ_IN_INDEX: number;
        COLUMN_NAME: string | null;
        NON_UNIQUE: number;
        INDEX_TYPE: string;
        SUB_PART: number | null;
        IS_VISIBLE?: string | null;
        EXPRESSION?: string | null;
      }>
    >(
      connection,
      `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME,
              NON_UNIQUE, INDEX_TYPE, SUB_PART,
              IS_VISIBLE, EXPRESSION
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME IN (${inListPlaceholders(chunk)})
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [db, ...chunk],
    );
    for (const r of rows) {
      const tableIdxs = acc.get(r.TABLE_NAME) ?? new Map<string, IndexDef>();
      const existing = tableIdxs.get(r.INDEX_NAME);
      // Functional indexes have NULL COLUMN_NAME and a non-NULL EXPRESSION.
      const colName = r.COLUMN_NAME ?? `(${r.EXPRESSION ?? "expr"})`;
      if (existing) {
        existing.columns.push(colName);
        existing.subParts.push(r.SUB_PART);
        existing.expressions.push(r.EXPRESSION ?? null);
      } else {
        tableIdxs.set(r.INDEX_NAME, {
          name: r.INDEX_NAME,
          columns: [colName],
          unique: r.NON_UNIQUE === 0,
          type: r.INDEX_TYPE,
          // IS_VISIBLE column is "YES"/"NO" in MySQL 8+, undefined elsewhere.
          // Treat unknown as visible.
          visible: r.IS_VISIBLE !== "NO",
          subParts: [r.SUB_PART],
          expressions: [r.EXPRESSION ?? null],
        });
      }
      acc.set(r.TABLE_NAME, tableIdxs);
    }
  }
  const out = new Map<string, IndexDef[]>();
  for (const [t, map] of acc) out.set(t, [...map.values()]);
  return out;
}

export async function listForeignKeys(
  connection: string,
  db: string,
  tables: string[],
): Promise<Map<string, ForeignKey[]>> {
  const acc = new Map<string, Map<string, ForeignKey>>();
  for (const chunk of chunkArray(tables)) {
    const rows = await queryWithTimeout<
      Array<{
        TABLE_NAME: string;
        CONSTRAINT_NAME: string;
        COLUMN_NAME: string;
        REFERENCED_TABLE_NAME: string;
        REFERENCED_COLUMN_NAME: string;
        ORDINAL_POSITION: number;
        UPDATE_RULE: string;
        DELETE_RULE: string;
      }>
    >(
      connection,
      `SELECT kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
              kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
              kcu.ORDINAL_POSITION,
              rc.UPDATE_RULE, rc.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE kcu
       JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
         ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
       WHERE kcu.TABLE_SCHEMA = ?
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         AND kcu.TABLE_NAME IN (${inListPlaceholders(chunk)})
       ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
      [db, ...chunk],
    );
    for (const r of rows) {
      const tableFKs = acc.get(r.TABLE_NAME) ?? new Map<string, ForeignKey>();
      const existing = tableFKs.get(r.CONSTRAINT_NAME);
      if (existing) {
        existing.columns.push(r.COLUMN_NAME);
        existing.referencedColumns.push(r.REFERENCED_COLUMN_NAME);
      } else {
        tableFKs.set(r.CONSTRAINT_NAME, {
          name: r.CONSTRAINT_NAME,
          columns: [r.COLUMN_NAME],
          referencedTable: r.REFERENCED_TABLE_NAME,
          referencedColumns: [r.REFERENCED_COLUMN_NAME],
          onUpdate: r.UPDATE_RULE,
          onDelete: r.DELETE_RULE,
        });
      }
      acc.set(r.TABLE_NAME, tableFKs);
    }
  }
  const out = new Map<string, ForeignKey[]>();
  for (const [t, map] of acc) out.set(t, [...map.values()]);
  return out;
}

export async function listViews(
  connection: string,
  db: string,
): Promise<View[]> {
  const rows = await queryWithTimeout<
    Array<{
      TABLE_NAME: string;
      VIEW_DEFINITION: string;
      IS_UPDATABLE: string;
      SECURITY_TYPE: string;
      CHECK_OPTION: string;
    }>
  >(
    connection,
    `SELECT TABLE_NAME, VIEW_DEFINITION, IS_UPDATABLE, SECURITY_TYPE, CHECK_OPTION
     FROM information_schema.VIEWS
     WHERE TABLE_SCHEMA = ?
     ORDER BY TABLE_NAME`,
    [db],
  );
  return rows.map((r) => ({
    name: r.TABLE_NAME,
    definition: r.VIEW_DEFINITION,
    updatable: r.IS_UPDATABLE === "YES",
    securityType: r.SECURITY_TYPE,
    checkOption: r.CHECK_OPTION,
  }));
}

export async function listRoutines(
  connection: string,
  db: string,
): Promise<Routine[]> {
  const rows = await queryWithTimeout<
    Array<{
      ROUTINE_NAME: string;
      ROUTINE_TYPE: string;
      DTD_IDENTIFIER: string | null;
      ROUTINE_DEFINITION: string;
      SECURITY_TYPE: string;
      IS_DETERMINISTIC: string;
      SQL_DATA_ACCESS: string;
    }>
  >(
    connection,
    `SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, ROUTINE_DEFINITION,
            SECURITY_TYPE, IS_DETERMINISTIC, SQL_DATA_ACCESS
     FROM information_schema.ROUTINES
     WHERE ROUTINE_SCHEMA = ?
     ORDER BY ROUTINE_NAME`,
    [db],
  );

  // Parameter signatures are in a separate table.
  const paramRows = await queryWithTimeout<
    Array<{
      SPECIFIC_NAME: string;
      PARAMETER_NAME: string | null;
      PARAMETER_MODE: string | null;
      DTD_IDENTIFIER: string;
      ORDINAL_POSITION: number;
    }>
  >(
    connection,
    `SELECT SPECIFIC_NAME, PARAMETER_NAME, PARAMETER_MODE, DTD_IDENTIFIER,
            ORDINAL_POSITION
     FROM information_schema.PARAMETERS
     WHERE SPECIFIC_SCHEMA = ?
     ORDER BY SPECIFIC_NAME, ORDINAL_POSITION`,
    [db],
  );
  // Render each routine's parameter list as a canonical signature
  // string (mode, name, type) — easy to diff.
  const paramsByName = new Map<string, string[]>();
  for (const p of paramRows) {
    // Functions have an unnamed ordinal-0 row that's the RETURN type.
    // Skip it here; we already capture it in DTD_IDENTIFIER above.
    if (p.ORDINAL_POSITION === 0) continue;
    const arr = paramsByName.get(p.SPECIFIC_NAME) ?? [];
    arr.push(
      `${p.PARAMETER_MODE ?? "IN"} ${p.PARAMETER_NAME ?? "?"} ${p.DTD_IDENTIFIER}`,
    );
    paramsByName.set(p.SPECIFIC_NAME, arr);
  }

  return rows.map((r) => ({
    name: r.ROUTINE_NAME,
    type: r.ROUTINE_TYPE as "PROCEDURE" | "FUNCTION",
    returnType: r.ROUTINE_TYPE === "FUNCTION" ? r.DTD_IDENTIFIER : null,
    parameters: (paramsByName.get(r.ROUTINE_NAME) ?? []).join(", "),
    definition: r.ROUTINE_DEFINITION,
    securityType: r.SECURITY_TYPE,
    deterministic: r.IS_DETERMINISTIC === "YES",
    dataAccess: r.SQL_DATA_ACCESS,
  }));
}

export async function listTriggers(
  connection: string,
  db: string,
): Promise<Trigger[]> {
  const rows = await queryWithTimeout<
    Array<{
      TRIGGER_NAME: string;
      EVENT_OBJECT_TABLE: string;
      EVENT_MANIPULATION: string;
      ACTION_TIMING: string;
      ACTION_ORIENTATION: string;
      ACTION_STATEMENT: string;
    }>
  >(
    connection,
    `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, EVENT_MANIPULATION,
            ACTION_TIMING, ACTION_ORIENTATION, ACTION_STATEMENT
     FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = ?
     ORDER BY TRIGGER_NAME`,
    [db],
  );
  return rows.map((r) => ({
    name: r.TRIGGER_NAME,
    table: r.EVENT_OBJECT_TABLE,
    event: r.EVENT_MANIPULATION,
    timing: r.ACTION_TIMING,
    orientation: r.ACTION_ORIENTATION,
    statement: r.ACTION_STATEMENT,
  }));
}

export async function listEvents(
  connection: string,
  db: string,
): Promise<Event[]> {
  const rows = await queryWithTimeout<
    Array<{
      EVENT_NAME: string;
      EVENT_TYPE: string;
      INTERVAL_VALUE: string | null;
      INTERVAL_FIELD: string | null;
      STATUS: string;
      STARTS: string | null;
      ENDS: string | null;
      EVENT_DEFINITION: string;
    }>
  >(
    connection,
    `SELECT EVENT_NAME, EVENT_TYPE, INTERVAL_VALUE, INTERVAL_FIELD,
            STATUS, STARTS, ENDS, EVENT_DEFINITION
     FROM information_schema.EVENTS
     WHERE EVENT_SCHEMA = ?
     ORDER BY EVENT_NAME`,
    [db],
  );
  return rows.map((r) => ({
    name: r.EVENT_NAME,
    type: r.EVENT_TYPE,
    intervalValue: r.INTERVAL_VALUE,
    intervalField: r.INTERVAL_FIELD,
    status: r.STATUS,
    starts: r.STARTS,
    ends: r.ENDS,
    definition: r.EVENT_DEFINITION,
  }));
}

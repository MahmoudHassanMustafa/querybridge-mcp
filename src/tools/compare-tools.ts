import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWithTimeout } from "../connection.js";
import {
  resolveDb,
  toolOk,
  toolError,
  toolHandler,
  emitProgress,
} from "../helpers.js";

// ═══════════════════════════════════════════════════════════════════
// Scope
// ═══════════════════════════════════════════════════════════════════

const SCOPES = [
  "tables",
  "tableAttributes",
  "columns",
  "indexes",
  "foreignKeys",
  "views",
  "routines",
  "triggers",
  "events",
] as const;
type Scope = (typeof SCOPES)[number];

// ═══════════════════════════════════════════════════════════════════
// Normalized comparison types
// ═══════════════════════════════════════════════════════════════════

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  key: string;
  comment: string;
  /** EXTRA column: AUTO_INCREMENT, ON UPDATE CURRENT_TIMESTAMP, STORED/VIRTUAL GENERATED, etc. */
  extra: string;
  /** Generated-column expression (NULL for regular columns) */
  generationExpression: string | null;
}

interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
  /** MySQL 8 invisible indexes — same definition, hidden from the optimizer */
  visible: boolean;
  /** Per-column prefix lengths (e.g. INDEX(email(100))). null = full column. */
  subParts: Array<number | null>;
  /** Functional index expressions (MySQL 8). null when not a functional index. */
  expressions: Array<string | null>;
}

interface ForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
}

interface TableAttributes {
  name: string;
  engine: string;
  charset: string;
  collation: string;
  comment: string;
  rowFormat: string;
  partitioned: boolean;
  partitionMethod: string | null;
  partitionExpression: string | null;
  partitionCount: number;
}

interface View {
  name: string;
  definition: string;
  updatable: boolean;
  securityType: string;
  checkOption: string;
}

interface Routine {
  name: string;
  type: "PROCEDURE" | "FUNCTION";
  returnType: string | null;
  parameters: string;
  definition: string;
  securityType: string;
  deterministic: boolean;
  dataAccess: string;
}

interface Trigger {
  name: string;
  table: string;
  event: string;
  timing: string;
  orientation: string;
  statement: string;
}

interface Event {
  name: string;
  type: string;
  intervalValue: string | null;
  intervalField: string | null;
  status: string;
  starts: string | null;
  ends: string | null;
  definition: string;
}

// ═══════════════════════════════════════════════════════════════════
// Diff types
// ═══════════════════════════════════════════════════════════════════

interface BaseDiff<T> {
  onlyInSource: T[];
  onlyInTarget: T[];
  modified: Array<{ name: string; source: T; target: T; diffs: string[] }>;
}
type ColumnDiff = BaseDiff<Column>;
type IndexDiff = BaseDiff<IndexDef>;
type FKDiff = BaseDiff<ForeignKey>;
type TableAttrDiff = BaseDiff<TableAttributes>;
type ViewDiff = BaseDiff<View>;
type RoutineDiff = BaseDiff<Routine>;
type TriggerDiff = BaseDiff<Trigger>;
type EventDiff = BaseDiff<Event>;

// ═══════════════════════════════════════════════════════════════════
// Tool registration
// ═══════════════════════════════════════════════════════════════════

export function registerCompareTools(server: McpServer) {
  server.registerTool(
    "compare_schemas",
    {
      title: "Compare schemas",
      description:
        "Diff the schemas of two databases (can be across different connections). " +
        "Reports tables, table attributes (engine/charset/partitioning), columns, " +
        "indexes, foreign keys, views, routines, triggers, and events that exist " +
        "only in source, only in target, or differ. Use the `scope` arg to narrow " +
        "to a cheaper subset on huge schemas.",
      inputSchema: {
        sourceConnection: z.string().describe("Source connection name"),
        sourceDatabase: z
          .string()
          .optional()
          .describe("Source database (uses the connection's active db if omitted)"),
        targetConnection: z
          .string()
          .describe("Target connection name (may be the same as sourceConnection)"),
        targetDatabase: z
          .string()
          .optional()
          .describe("Target database (uses the connection's active db if omitted)"),
        tables: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict comparison to these table names (default: all tables that exist in either side). " +
              "Does NOT affect views/routines/triggers/events — those are always considered in full.",
          ),
        scope: z
          .array(z.enum(SCOPES))
          .optional()
          .describe(
            `Which aspects to compare. Default: all (${SCOPES.join(", ")}). ` +
              `For huge schemas pass a subset like ["tables", "indexes"].`,
          ),
        summaryOnly: z
          .boolean()
          .optional()
          .describe(
            "Skip per-table detail rendering in the markdown output. " +
              "Summary counts + only-in-source/target lists only. " +
              "Structured content is unaffected. Useful for huge diffs that " +
              "would otherwise blow past the model's context budget.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    toolHandler(
      "compare_schemas",
      async (
        {
          sourceConnection,
          sourceDatabase,
          targetConnection,
          targetDatabase,
          tables: tableFilter,
          scope,
          summaryOnly,
        },
        extra,
      ) => {
        const src = resolveDb(sourceConnection, sourceDatabase);
        if ("error" in src) return src.error;
        const tgt = resolveDb(targetConnection, targetDatabase);
        if ("error" in tgt) return tgt.error;

        const scopes: Scope[] = scope && scope.length > 0 ? scope : [...SCOPES];
        const want = (s: Scope) => scopes.includes(s);

        // Honor client-side cancellation. Checked between each scope —
        // mid-scope cancellation would orphan in-flight queries. Same
        // pattern as execute_query for consistency.
        const aborted = () => extra?.signal?.aborted === true;
        if (aborted()) return toolError("Request cancelled before execution.");

        const totalSteps = scopes.length;
        let step = 0;
        const tick = async (label: string) => {
          step += 1;
          await emitProgress(extra, step, totalSteps, label);
        };

        // ── Phase 1: Tables ─────────────────────────────────────────
        await emitProgress(extra, 0, totalSteps, "Listing tables");

        const [srcTables, tgtTables] = await Promise.all([
          listTables(sourceConnection, src.db),
          listTables(targetConnection, tgt.db),
        ]);

        const filter = tableFilter && tableFilter.length > 0 ? new Set(tableFilter) : null;
        const srcSet = filter
          ? new Set(srcTables.filter((t) => filter.has(t)))
          : new Set(srcTables);
        const tgtSet = filter
          ? new Set(tgtTables.filter((t) => filter.has(t)))
          : new Set(tgtTables);

        const onlyInSource = [...srcSet].filter((t) => !tgtSet.has(t)).sort();
        const onlyInTarget = [...tgtSet].filter((t) => !srcSet.has(t)).sort();
        const shared = [...srcSet].filter((t) => tgtSet.has(t)).sort();

        if (want("tables")) await tick("Compared tables");
        if (aborted()) return toolError("Request cancelled after table listing.");

        const sharedNames = shared.length > 0 ? shared : null;

        // ── Per-aspect diffs ─────────────────────────────────────────
        const tableAttrDiff: TableAttrDiff = emptyDiff();
        const colDiffs = new Map<string, ColumnDiff>();
        const idxDiffs = new Map<string, IndexDiff>();
        const fkDiffs = new Map<string, FKDiff>();
        let viewDiff: ViewDiff = emptyDiff();
        let routineDiff: RoutineDiff = emptyDiff();
        let triggerDiff: TriggerDiff = emptyDiff();
        let eventDiff: EventDiff = emptyDiff();

        if (want("tableAttributes") && sharedNames) {
          const [srcAttrs, tgtAttrs] = await Promise.all([
            listTableAttributes(sourceConnection, src.db, sharedNames),
            listTableAttributes(targetConnection, tgt.db, sharedNames),
          ]);
          Object.assign(tableAttrDiff, diffTableAttributes(srcAttrs, tgtAttrs));
          await tick("Compared table attributes");
          if (aborted()) return toolError("Request cancelled.");
        }

        if (want("columns") && sharedNames) {
          const [srcCols, tgtCols] = await Promise.all([
            listColumns(sourceConnection, src.db, sharedNames),
            listColumns(targetConnection, tgt.db, sharedNames),
          ]);
          for (const t of sharedNames) {
            const diff = diffColumns(srcCols.get(t) ?? [], tgtCols.get(t) ?? []);
            if (diffHasContent(diff)) colDiffs.set(t, diff);
          }
          await tick("Compared columns");
          if (aborted()) return toolError("Request cancelled.");
        }

        if (want("indexes") && sharedNames) {
          const [srcIdx, tgtIdx] = await Promise.all([
            listIndexes(sourceConnection, src.db, sharedNames),
            listIndexes(targetConnection, tgt.db, sharedNames),
          ]);
          for (const t of sharedNames) {
            const diff = diffIndexes(srcIdx.get(t) ?? [], tgtIdx.get(t) ?? []);
            if (diffHasContent(diff)) idxDiffs.set(t, diff);
          }
          await tick("Compared indexes");
          if (aborted()) return toolError("Request cancelled.");
        }

        if (want("foreignKeys") && sharedNames) {
          const [srcFK, tgtFK] = await Promise.all([
            listForeignKeys(sourceConnection, src.db, sharedNames),
            listForeignKeys(targetConnection, tgt.db, sharedNames),
          ]);
          for (const t of sharedNames) {
            const diff = diffForeignKeys(srcFK.get(t) ?? [], tgtFK.get(t) ?? []);
            if (diffHasContent(diff)) fkDiffs.set(t, diff);
          }
          await tick("Compared foreign keys");
          if (aborted()) return toolError("Request cancelled.");
        }

        if (want("views")) {
          const [srcViews, tgtViews] = await Promise.all([
            listViews(sourceConnection, src.db),
            listViews(targetConnection, tgt.db),
          ]);
          viewDiff = diffViews(srcViews, tgtViews);
          await tick("Compared views");
          if (aborted()) return toolError("Request cancelled.");
        }

        if (want("routines")) {
          const [srcRoutines, tgtRoutines] = await Promise.all([
            listRoutines(sourceConnection, src.db),
            listRoutines(targetConnection, tgt.db),
          ]);
          routineDiff = diffRoutines(srcRoutines, tgtRoutines);
          await tick("Compared routines");
          if (aborted()) return toolError("Request cancelled.");
        }

        if (want("triggers")) {
          const [srcTrig, tgtTrig] = await Promise.all([
            listTriggers(sourceConnection, src.db),
            listTriggers(targetConnection, tgt.db),
          ]);
          triggerDiff = diffTriggers(srcTrig, tgtTrig);
          await tick("Compared triggers");
          if (aborted()) return toolError("Request cancelled.");
        }

        if (want("events")) {
          const [srcEvents, tgtEvents] = await Promise.all([
            listEvents(sourceConnection, src.db),
            listEvents(targetConnection, tgt.db),
          ]);
          eventDiff = diffEvents(srcEvents, tgtEvents);
          await tick("Compared events");
        }

        // ── Aggregate per-table details ────────────────────────────
        const detailTables = new Set<string>([
          ...colDiffs.keys(),
          ...idxDiffs.keys(),
          ...fkDiffs.keys(),
          ...tableAttrDiff.modified.map((m) => m.name),
        ]);

        const details = [...detailTables].sort().map((table) => ({
          table,
          ...(tableAttrDiff.modified.find((m) => m.name === table)
            ? {
                attributes:
                  tableAttrDiff.modified.find((m) => m.name === table)?.diffs,
              }
            : {}),
          ...(colDiffs.has(table) ? { columns: colDiffs.get(table) } : {}),
          ...(idxDiffs.has(table) ? { indexes: idxDiffs.get(table) } : {}),
          ...(fkDiffs.has(table) ? { foreignKeys: fkDiffs.get(table) } : {}),
        }));

        // ── Summary counts ──────────────────────────────────────────
        const summary = {
          tablesOnlyInSource: onlyInSource.length,
          tablesOnlyInTarget: onlyInTarget.length,
          tablesShared: shared.length,
          tablesModified: detailTables.size,
          tableAttrsModified: tableAttrDiff.modified.length,
          columnsAdded: sumAcross(colDiffs, (d) => d.onlyInTarget.length),
          columnsRemoved: sumAcross(colDiffs, (d) => d.onlyInSource.length),
          columnsModified: sumAcross(colDiffs, (d) => d.modified.length),
          indexesAdded: sumAcross(idxDiffs, (d) => d.onlyInTarget.length),
          indexesRemoved: sumAcross(idxDiffs, (d) => d.onlyInSource.length),
          indexesModified: sumAcross(idxDiffs, (d) => d.modified.length),
          fksAdded: sumAcross(fkDiffs, (d) => d.onlyInTarget.length),
          fksRemoved: sumAcross(fkDiffs, (d) => d.onlyInSource.length),
          fksModified: sumAcross(fkDiffs, (d) => d.modified.length),
          viewsAdded: viewDiff.onlyInTarget.length,
          viewsRemoved: viewDiff.onlyInSource.length,
          viewsModified: viewDiff.modified.length,
          routinesAdded: routineDiff.onlyInTarget.length,
          routinesRemoved: routineDiff.onlyInSource.length,
          routinesModified: routineDiff.modified.length,
          triggersAdded: triggerDiff.onlyInTarget.length,
          triggersRemoved: triggerDiff.onlyInSource.length,
          triggersModified: triggerDiff.modified.length,
          eventsAdded: eventDiff.onlyInTarget.length,
          eventsRemoved: eventDiff.onlyInSource.length,
          eventsModified: eventDiff.modified.length,
        };

        const inSync =
          onlyInSource.length === 0 &&
          onlyInTarget.length === 0 &&
          detailTables.size === 0 &&
          !diffHasContent(viewDiff) &&
          !diffHasContent(routineDiff) &&
          !diffHasContent(triggerDiff) &&
          !diffHasContent(eventDiff);

        const structured = {
          source: { connection: sourceConnection, database: src.db },
          target: { connection: targetConnection, database: tgt.db },
          scope: scopes,
          tables: { onlyInSource, onlyInTarget, shared },
          details,
          views: viewDiff,
          routines: routineDiff,
          triggers: triggerDiff,
          events: eventDiff,
          summary: { ...summary, inSync },
        };

        const text = renderMarkdown(structured, summaryOnly === true);
        return toolOk(text, structured);
      },
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════

/**
 * IN(...) parameter placeholders. Cheaper than one round-trip per name.
 */
function inListPlaceholders(values: string[]): string {
  return values.map(() => "?").join(",");
}

/**
 * Slice a list into chunks. Used to keep IN-list queries below the
 * server's max_allowed_packet on huge schemas. 500 names is well under
 * the default 16MB packet ceiling and keeps a query string under ~10KB.
 */
function chunkArray<T>(arr: T[], size = 500): T[][] {
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
function normalizeType(t: string): string {
  // tinyint(1) is the boolean idiom — keep it
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
 * by selecting from the ROUTINES.ROUTINE_DEFINITION / etc. columns
 * (those return the body without the wrapping CREATE clause).
 */
function normalizeSQL(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

function formatDefault(d: string | null): string {
  if (d === null) return "NULL";
  return `'${d}'`;
}

function sumAcross<T>(map: Map<string, T>, pick: (v: T) => number): number {
  let total = 0;
  for (const v of map.values()) total += pick(v);
  return total;
}

function emptyDiff<T>(): BaseDiff<T> {
  return { onlyInSource: [], onlyInTarget: [], modified: [] };
}

function diffHasContent(d: BaseDiff<unknown>): boolean {
  return d.onlyInSource.length > 0 || d.onlyInTarget.length > 0 || d.modified.length > 0;
}

// ═══════════════════════════════════════════════════════════════════
// Fetchers
// ═══════════════════════════════════════════════════════════════════

async function listTables(connection: string, db: string): Promise<string[]> {
  const rows = await queryWithTimeout<Array<{ TABLE_NAME: string }>>(
    connection,
    `SELECT TABLE_NAME
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
    [db],
  );
  return rows.map((r) => r.TABLE_NAME);
}

async function listTableAttributes(
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
    const collationByTable = new Map(rows.map((r) => [r.TABLE_NAME, r.TABLE_COLLATION ?? ""]));
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

async function listColumns(
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

async function listIndexes(
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

async function listForeignKeys(
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

async function listViews(connection: string, db: string): Promise<View[]> {
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

async function listRoutines(connection: string, db: string): Promise<Routine[]> {
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

async function listTriggers(connection: string, db: string): Promise<Trigger[]> {
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

async function listEvents(connection: string, db: string): Promise<Event[]> {
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

// ═══════════════════════════════════════════════════════════════════
// Diff functions (pure — exported for unit tests)
// ═══════════════════════════════════════════════════════════════════

export function diffColumns(srcCols: Column[], tgtCols: Column[]): ColumnDiff {
  return diffByName(srcCols, tgtCols, (src, tgt) => {
    const diffs: string[] = [];
    const srcType = normalizeType(src.type);
    const tgtType = normalizeType(tgt.type);
    if (srcType !== tgtType) diffs.push(`type: ${srcType} → ${tgtType}`);
    if (src.nullable !== tgt.nullable)
      diffs.push(`nullable: ${src.nullable} → ${tgt.nullable}`);
    if (src.default !== tgt.default)
      diffs.push(`default: ${formatDefault(src.default)} → ${formatDefault(tgt.default)}`);
    if (src.key !== tgt.key)
      diffs.push(`key: ${src.key || "(none)"} → ${tgt.key || "(none)"}`);
    if (src.comment !== tgt.comment)
      diffs.push(`comment: '${src.comment}' → '${tgt.comment}'`);
    if (src.extra !== tgt.extra)
      diffs.push(`extra: '${src.extra}' → '${tgt.extra}'`);
    if (src.generationExpression !== tgt.generationExpression)
      diffs.push(
        `generated: ${src.generationExpression ?? "(none)"} → ${tgt.generationExpression ?? "(none)"}`,
      );
    return diffs;
  });
}

export function diffIndexes(srcIdx: IndexDef[], tgtIdx: IndexDef[]): IndexDiff {
  return diffByName(srcIdx, tgtIdx, (src, tgt) => {
    const diffs: string[] = [];
    if (src.columns.join(",") !== tgt.columns.join(","))
      diffs.push(`columns: (${src.columns.join(",")}) → (${tgt.columns.join(",")})`);
    if (src.unique !== tgt.unique)
      diffs.push(`unique: ${src.unique} → ${tgt.unique}`);
    if (src.type !== tgt.type) diffs.push(`type: ${src.type} → ${tgt.type}`);
    if (src.visible !== tgt.visible)
      diffs.push(`visible: ${src.visible} → ${tgt.visible}`);
    if (subPartString(src.subParts) !== subPartString(tgt.subParts))
      diffs.push(`prefix lengths: ${subPartString(src.subParts)} → ${subPartString(tgt.subParts)}`);
    return diffs;
  });
}

function subPartString(parts: Array<number | null>): string {
  return parts.map((p) => (p === null ? "full" : String(p))).join(",");
}

export function diffForeignKeys(srcFK: ForeignKey[], tgtFK: ForeignKey[]): FKDiff {
  return diffByName(srcFK, tgtFK, (src, tgt) => {
    const diffs: string[] = [];
    if (src.columns.join(",") !== tgt.columns.join(","))
      diffs.push(`columns: (${src.columns.join(",")}) → (${tgt.columns.join(",")})`);
    if (src.referencedTable !== tgt.referencedTable)
      diffs.push(`references: ${src.referencedTable} → ${tgt.referencedTable}`);
    if (src.referencedColumns.join(",") !== tgt.referencedColumns.join(","))
      diffs.push(
        `referenced columns: (${src.referencedColumns.join(",")}) → (${tgt.referencedColumns.join(",")})`,
      );
    if (src.onUpdate !== tgt.onUpdate)
      diffs.push(`ON UPDATE: ${src.onUpdate} → ${tgt.onUpdate}`);
    if (src.onDelete !== tgt.onDelete)
      diffs.push(`ON DELETE: ${src.onDelete} → ${tgt.onDelete}`);
    return diffs;
  });
}

export function diffTableAttributes(
  src: Map<string, TableAttributes>,
  tgt: Map<string, TableAttributes>,
): TableAttrDiff {
  const srcArr = [...src.values()];
  const tgtArr = [...tgt.values()];
  return diffByName(srcArr, tgtArr, (a, b) => {
    const diffs: string[] = [];
    if (a.engine !== b.engine) diffs.push(`engine: ${a.engine} → ${b.engine}`);
    if (a.charset !== b.charset) diffs.push(`charset: ${a.charset} → ${b.charset}`);
    if (a.collation !== b.collation)
      diffs.push(`collation: ${a.collation} → ${b.collation}`);
    if (a.comment !== b.comment)
      diffs.push(`comment: '${a.comment}' → '${b.comment}'`);
    if (a.rowFormat !== b.rowFormat)
      diffs.push(`row format: ${a.rowFormat} → ${b.rowFormat}`);
    if (a.partitioned !== b.partitioned)
      diffs.push(`partitioning: ${a.partitioned ? "yes" : "no"} → ${b.partitioned ? "yes" : "no"}`);
    else if (a.partitioned && b.partitioned) {
      if (a.partitionMethod !== b.partitionMethod)
        diffs.push(`partition method: ${a.partitionMethod} → ${b.partitionMethod}`);
      if (a.partitionExpression !== b.partitionExpression)
        diffs.push(`partition expr: ${a.partitionExpression} → ${b.partitionExpression}`);
      if (a.partitionCount !== b.partitionCount)
        diffs.push(`partition count: ${a.partitionCount} → ${b.partitionCount}`);
    }
    return diffs;
  });
}

export function diffViews(srcViews: View[], tgtViews: View[]): ViewDiff {
  return diffByName(srcViews, tgtViews, (a, b) => {
    const diffs: string[] = [];
    if (normalizeSQL(a.definition) !== normalizeSQL(b.definition))
      diffs.push("definition changed");
    if (a.updatable !== b.updatable)
      diffs.push(`updatable: ${a.updatable} → ${b.updatable}`);
    if (a.securityType !== b.securityType)
      diffs.push(`security: ${a.securityType} → ${b.securityType}`);
    if (a.checkOption !== b.checkOption)
      diffs.push(`check option: ${a.checkOption} → ${b.checkOption}`);
    return diffs;
  });
}

export function diffRoutines(srcR: Routine[], tgtR: Routine[]): RoutineDiff {
  return diffByName(srcR, tgtR, (a, b) => {
    const diffs: string[] = [];
    if (a.type !== b.type) diffs.push(`type: ${a.type} → ${b.type}`);
    if (a.returnType !== b.returnType)
      diffs.push(`returns: ${a.returnType ?? "(none)"} → ${b.returnType ?? "(none)"}`);
    if (a.parameters !== b.parameters)
      diffs.push(`parameters: (${a.parameters}) → (${b.parameters})`);
    if (normalizeSQL(a.definition) !== normalizeSQL(b.definition))
      diffs.push("body changed");
    if (a.securityType !== b.securityType)
      diffs.push(`security: ${a.securityType} → ${b.securityType}`);
    if (a.deterministic !== b.deterministic)
      diffs.push(`deterministic: ${a.deterministic} → ${b.deterministic}`);
    if (a.dataAccess !== b.dataAccess)
      diffs.push(`data access: ${a.dataAccess} → ${b.dataAccess}`);
    return diffs;
  });
}

export function diffTriggers(srcT: Trigger[], tgtT: Trigger[]): TriggerDiff {
  return diffByName(srcT, tgtT, (a, b) => {
    const diffs: string[] = [];
    if (a.table !== b.table) diffs.push(`table: ${a.table} → ${b.table}`);
    if (a.event !== b.event) diffs.push(`event: ${a.event} → ${b.event}`);
    if (a.timing !== b.timing) diffs.push(`timing: ${a.timing} → ${b.timing}`);
    if (a.orientation !== b.orientation)
      diffs.push(`orientation: ${a.orientation} → ${b.orientation}`);
    if (normalizeSQL(a.statement) !== normalizeSQL(b.statement))
      diffs.push("statement changed");
    return diffs;
  });
}

export function diffEvents(srcE: Event[], tgtE: Event[]): EventDiff {
  return diffByName(srcE, tgtE, (a, b) => {
    const diffs: string[] = [];
    if (a.type !== b.type) diffs.push(`type: ${a.type} → ${b.type}`);
    if (a.intervalValue !== b.intervalValue || a.intervalField !== b.intervalField)
      diffs.push(
        `interval: ${a.intervalValue ?? ""} ${a.intervalField ?? ""} → ${b.intervalValue ?? ""} ${b.intervalField ?? ""}`,
      );
    if (a.status !== b.status) diffs.push(`status: ${a.status} → ${b.status}`);
    if (normalizeSQL(a.definition) !== normalizeSQL(b.definition))
      diffs.push("body changed");
    return diffs;
  });
}

/**
 * Generic name-keyed differ. Avoids duplicating the same compare-by-name
 * + sort-results boilerplate across every object type.
 */
function diffByName<T extends { name: string }>(
  src: T[],
  tgt: T[],
  compare: (a: T, b: T) => string[],
): BaseDiff<T> {
  const srcMap = new Map(src.map((x) => [x.name, x]));
  const tgtMap = new Map(tgt.map((x) => [x.name, x]));
  const result: BaseDiff<T> = emptyDiff();

  for (const [name, a] of srcMap) {
    const b = tgtMap.get(name);
    if (!b) {
      result.onlyInSource.push(a);
      continue;
    }
    const diffs = compare(a, b);
    if (diffs.length > 0) result.modified.push({ name, source: a, target: b, diffs });
  }
  for (const [name, b] of tgtMap) {
    if (!srcMap.has(name)) result.onlyInTarget.push(b);
  }
  result.onlyInSource.sort((x, y) => x.name.localeCompare(y.name));
  result.onlyInTarget.sort((x, y) => x.name.localeCompare(y.name));
  result.modified.sort((x, y) => x.name.localeCompare(y.name));
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// Markdown rendering
// ═══════════════════════════════════════════════════════════════════

interface RenderInput {
  source: { connection: string; database: string };
  target: { connection: string; database: string };
  scope: Scope[];
  tables: { onlyInSource: string[]; onlyInTarget: string[]; shared: string[] };
  details: Array<{
    table: string;
    attributes?: string[] | undefined;
    columns?: ColumnDiff | undefined;
    indexes?: IndexDiff | undefined;
    foreignKeys?: FKDiff | undefined;
  }>;
  views: ViewDiff;
  routines: RoutineDiff;
  triggers: TriggerDiff;
  events: EventDiff;
  summary: {
    tablesOnlyInSource: number;
    tablesOnlyInTarget: number;
    tablesShared: number;
    tablesModified: number;
    tableAttrsModified: number;
    columnsAdded: number;
    columnsRemoved: number;
    columnsModified: number;
    indexesAdded: number;
    indexesRemoved: number;
    indexesModified: number;
    fksAdded: number;
    fksRemoved: number;
    fksModified: number;
    viewsAdded: number;
    viewsRemoved: number;
    viewsModified: number;
    routinesAdded: number;
    routinesRemoved: number;
    routinesModified: number;
    triggersAdded: number;
    triggersRemoved: number;
    triggersModified: number;
    eventsAdded: number;
    eventsRemoved: number;
    eventsModified: number;
    inSync: boolean;
  };
}

function renderMarkdown(r: RenderInput, summaryOnly: boolean): string {
  const out: string[] = [];
  out.push(
    `# Schema diff: ${r.source.connection}/${r.source.database} → ${r.target.connection}/${r.target.database}`,
  );
  out.push("");
  out.push(`Scope: ${r.scope.join(", ")}`);
  out.push("");

  if (r.summary.inSync) {
    out.push("**Schemas are in sync** ✓");
    return out.join("\n");
  }

  // ── Summary ─────────────────────────────────────────────────────
  out.push("## Summary");
  out.push("");
  pushCount(out, "Tables only in source", r.summary.tablesOnlyInSource);
  pushCount(out, "Tables only in target", r.summary.tablesOnlyInTarget);
  pushCount(out, "Tables shared", r.summary.tablesShared);
  pushCount(out, "Tables with differences", r.summary.tablesModified);
  pushCount(out, "Table attributes modified", r.summary.tableAttrsModified);
  pushTriad(out, "Columns", r.summary.columnsAdded, r.summary.columnsRemoved, r.summary.columnsModified);
  pushTriad(out, "Indexes", r.summary.indexesAdded, r.summary.indexesRemoved, r.summary.indexesModified);
  pushTriad(out, "Foreign keys", r.summary.fksAdded, r.summary.fksRemoved, r.summary.fksModified);
  pushTriad(out, "Views", r.summary.viewsAdded, r.summary.viewsRemoved, r.summary.viewsModified);
  pushTriad(out, "Routines", r.summary.routinesAdded, r.summary.routinesRemoved, r.summary.routinesModified);
  pushTriad(out, "Triggers", r.summary.triggersAdded, r.summary.triggersRemoved, r.summary.triggersModified);
  pushTriad(out, "Events", r.summary.eventsAdded, r.summary.eventsRemoved, r.summary.eventsModified);

  // ── Tables ──────────────────────────────────────────────────────
  if (r.tables.onlyInSource.length > 0) {
    out.push("");
    out.push("## Tables only in source");
    for (const t of r.tables.onlyInSource) out.push(`- \`${t}\``);
  }
  if (r.tables.onlyInTarget.length > 0) {
    out.push("");
    out.push("## Tables only in target");
    for (const t of r.tables.onlyInTarget) out.push(`- \`${t}\``);
  }

  if (summaryOnly) {
    out.push("");
    out.push("_Per-table details suppressed (summaryOnly=true). See `structuredContent` for the full diff._");
    return out.join("\n");
  }

  // ── Per-table details ──────────────────────────────────────────
  if (r.details.length > 0) {
    out.push("");
    out.push("## Modified tables");
    for (const d of r.details) {
      out.push("");
      out.push(`### \`${d.table}\``);
      if (d.attributes && d.attributes.length > 0) {
        out.push("");
        out.push("**Attributes**");
        for (const a of d.attributes) out.push(`- ${a}`);
      }
      if (d.columns) renderSubDiff(out, "Columns", d.columns, (c) => `\`${c.name}\` ${c.type}`);
      if (d.indexes) renderSubDiff(out, "Indexes", d.indexes, (i) => `\`${i.name}\` (${i.columns.join(",")})${i.unique ? " UNIQUE" : ""}${i.visible ? "" : " INVISIBLE"}`);
      if (d.foreignKeys)
        renderSubDiff(out, "Foreign keys", d.foreignKeys, (f) => `\`${f.name}\` (${f.columns.join(",")}) → ${f.referencedTable}(${f.referencedColumns.join(",")})`);
    }
  }

  // ── Programmability objects ────────────────────────────────────
  renderObjectDiff(out, "Views", r.views, (v) => `\`${v.name}\``);
  renderObjectDiff(out, "Routines", r.routines, (r2) => `\`${r2.name}\` (${r2.type})`);
  renderObjectDiff(out, "Triggers", r.triggers, (t) => `\`${t.name}\` on \`${t.table}\``);
  renderObjectDiff(out, "Events", r.events, (e) => `\`${e.name}\``);

  return out.join("\n");
}

function pushCount(out: string[], label: string, n: number): void {
  if (n > 0) out.push(`- ${label}: ${n}`);
}
function pushTriad(out: string[], label: string, added: number, removed: number, modified: number): void {
  if (added + removed + modified > 0)
    out.push(`- ${label}: +${added} / -${removed} / ~${modified}`);
}

function renderSubDiff<T extends { name: string }>(
  out: string[],
  label: string,
  diff: BaseDiff<T>,
  fmt: (x: T) => string,
): void {
  out.push("");
  out.push(`**${label}**`);
  for (const x of diff.onlyInSource) out.push(`- only in source: ${fmt(x)}`);
  for (const x of diff.onlyInTarget) out.push(`- only in target: ${fmt(x)}`);
  for (const m of diff.modified) out.push(`- modified \`${m.name}\`: ${m.diffs.join("; ")}`);
}

function renderObjectDiff<T extends { name: string }>(
  out: string[],
  label: string,
  diff: BaseDiff<T>,
  fmt: (x: T) => string,
): void {
  if (!diffHasContent(diff)) return;
  out.push("");
  out.push(`## ${label}`);
  for (const x of diff.onlyInSource) out.push(`- only in source: ${fmt(x)}`);
  for (const x of diff.onlyInTarget) out.push(`- only in target: ${fmt(x)}`);
  for (const m of diff.modified) out.push(`- modified ${fmt(m.source)}: ${m.diffs.join("; ")}`);
}

// ═══════════════════════════════════════════════════════════════════
// Exports for tests
// ═══════════════════════════════════════════════════════════════════

export type {
  Column,
  IndexDef,
  ForeignKey,
  TableAttributes,
  View,
  Routine,
  Trigger,
  Event,
  ColumnDiff,
  IndexDiff,
  FKDiff,
  TableAttrDiff,
  ViewDiff,
  RoutineDiff,
  TriggerDiff,
  EventDiff,
};

// Internal utilities exported so tests can hit them directly.
export const __test = {
  normalizeType,
  normalizeSQL,
  chunkArray,
};

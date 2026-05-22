import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWithTimeout } from "../connection.js";
import { resolveDb, toolOk, toolHandler, emitProgress } from "../helpers.js";

const SCOPES = ["tables", "columns", "indexes", "foreignKeys"] as const;
type Scope = (typeof SCOPES)[number];

// ── Wire types from information_schema ──────────────────────────────

interface ColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string; // "YES" / "NO"
  COLUMN_DEFAULT: string | null;
  COLUMN_KEY: string;
  ORDINAL_POSITION: number;
}

interface IndexRow {
  TABLE_NAME: string;
  INDEX_NAME: string;
  SEQ_IN_INDEX: number;
  COLUMN_NAME: string;
  NON_UNIQUE: number;
  INDEX_TYPE: string;
}

interface FKRow {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  UPDATE_RULE: string;
  DELETE_RULE: string;
  ORDINAL_POSITION: number;
}

// ── Normalized comparison types ─────────────────────────────────────

interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  key: string;
}

interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
}

interface ForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
}

// ── Tool registration ──────────────────────────────────────────────

export function registerCompareTools(server: McpServer) {
  server.registerTool(
    "compare_schemas",
    {
      title: "Compare schemas",
      description:
        "Diff the schemas of two databases (can be across different connections). Reports tables / columns / indexes / foreign keys that exist only in source, only in target, or differ. Skips views, routines, triggers, and events — use the dedicated tools for those.",
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
            "Restrict comparison to these table names (default: all tables that exist in either side)",
          ),
        scope: z
          .array(z.enum(SCOPES))
          .optional()
          .describe(
            `Which aspects to compare. Default: ${SCOPES.join(", ")}. Skip costly ones for huge schemas (e.g. ["tables", "indexes"]).`,
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
        },
        extra,
      ) => {
        const src = resolveDb(sourceConnection, sourceDatabase);
        if ("error" in src) return src.error;
        const tgt = resolveDb(targetConnection, targetDatabase);
        if ("error" in tgt) return tgt.error;

        const scopes: Scope[] = scope && scope.length > 0 ? scope : [...SCOPES];
        const want = (s: Scope) => scopes.includes(s);

        // Total progress = one step per scope (~equal cost since each is
        // a single information_schema query per side). Keeps the
        // arithmetic honest if the client renders a progress bar.
        const totalSteps = scopes.length;
        let step = 0;
        const tick = async (label: string) => {
          step += 1;
          await emitProgress(extra, step, totalSteps, label);
        };

        // ── Phase 1: Tables ────────────────────────────────────────
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

        // ── Phase 2..N: Per-aspect for shared tables ────────────────
        const sharedNames = shared.length > 0 ? shared : null;

        const colDiffs = new Map<string, ColumnDiff>();
        const idxDiffs = new Map<string, IndexDiff>();
        const fkDiffs = new Map<string, FKDiff>();

        if (want("columns") && sharedNames) {
          const [srcCols, tgtCols] = await Promise.all([
            listColumns(sourceConnection, src.db, sharedNames),
            listColumns(targetConnection, tgt.db, sharedNames),
          ]);
          for (const t of sharedNames) {
            const a = srcCols.get(t) ?? [];
            const b = tgtCols.get(t) ?? [];
            const diff = diffColumns(a, b);
            if (diffHasContent(diff)) colDiffs.set(t, diff);
          }
          await tick("Compared columns");
        }

        if (want("indexes") && sharedNames) {
          const [srcIdx, tgtIdx] = await Promise.all([
            listIndexes(sourceConnection, src.db, sharedNames),
            listIndexes(targetConnection, tgt.db, sharedNames),
          ]);
          for (const t of sharedNames) {
            const a = srcIdx.get(t) ?? [];
            const b = tgtIdx.get(t) ?? [];
            const diff = diffIndexes(a, b);
            if (diffHasContent(diff)) idxDiffs.set(t, diff);
          }
          await tick("Compared indexes");
        }

        if (want("foreignKeys") && sharedNames) {
          const [srcFK, tgtFK] = await Promise.all([
            listForeignKeys(sourceConnection, src.db, sharedNames),
            listForeignKeys(targetConnection, tgt.db, sharedNames),
          ]);
          for (const t of sharedNames) {
            const a = srcFK.get(t) ?? [];
            const b = tgtFK.get(t) ?? [];
            const diff = diffForeignKeys(a, b);
            if (diffHasContent(diff)) fkDiffs.set(t, diff);
          }
          await tick("Compared foreign keys");
        }

        // ── Assemble result ─────────────────────────────────────────
        const detailTables = new Set<string>([
          ...colDiffs.keys(),
          ...idxDiffs.keys(),
          ...fkDiffs.keys(),
        ]);

        const details = [...detailTables].sort().map((table) => ({
          table,
          ...(colDiffs.has(table) ? { columns: colDiffs.get(table) } : {}),
          ...(idxDiffs.has(table) ? { indexes: idxDiffs.get(table) } : {}),
          ...(fkDiffs.has(table) ? { foreignKeys: fkDiffs.get(table) } : {}),
        }));

        const summary = {
          tablesOnlyInSource: onlyInSource.length,
          tablesOnlyInTarget: onlyInTarget.length,
          tablesShared: shared.length,
          tablesModified: detailTables.size,
          columnsAdded: sumAcross(colDiffs, (d) => d.onlyInTarget.length),
          columnsRemoved: sumAcross(colDiffs, (d) => d.onlyInSource.length),
          columnsModified: sumAcross(colDiffs, (d) => d.modified.length),
          indexesAdded: sumAcross(idxDiffs, (d) => d.onlyInTarget.length),
          indexesRemoved: sumAcross(idxDiffs, (d) => d.onlyInSource.length),
          indexesModified: sumAcross(idxDiffs, (d) => d.modified.length),
          fksAdded: sumAcross(fkDiffs, (d) => d.onlyInTarget.length),
          fksRemoved: sumAcross(fkDiffs, (d) => d.onlyInSource.length),
          fksModified: sumAcross(fkDiffs, (d) => d.modified.length),
        };
        const inSync =
          onlyInSource.length === 0 &&
          onlyInTarget.length === 0 &&
          detailTables.size === 0;

        const structured = {
          source: { connection: sourceConnection, database: src.db },
          target: { connection: targetConnection, database: tgt.db },
          scope: scopes,
          tables: { onlyInSource, onlyInTarget, shared },
          details,
          summary: { ...summary, inSync },
        };

        const text = renderMarkdown(structured);
        return toolOk(text, structured);
      },
    ),
  );
}

// ── Fetchers (batched per connection) ───────────────────────────────

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

/**
 * Build a single IN-list query for the shared tables. Cheaper than one
 * round-trip per table, and information_schema is happy with a few
 * hundred names in an IN clause.
 */
function inListPlaceholders(values: string[]): string {
  return values.map(() => "?").join(",");
}

async function listColumns(
  connection: string,
  db: string,
  tables: string[],
): Promise<Map<string, Column[]>> {
  const rows = await queryWithTimeout<ColumnRow[]>(
    connection,
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
            COLUMN_DEFAULT, COLUMN_KEY, ORDINAL_POSITION
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME IN (${inListPlaceholders(tables)})
     ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [db, ...tables],
  );
  const byTable = new Map<string, Column[]>();
  for (const r of rows) {
    const arr = byTable.get(r.TABLE_NAME) ?? [];
    arr.push({
      name: r.COLUMN_NAME,
      type: r.COLUMN_TYPE,
      nullable: r.IS_NULLABLE === "YES",
      default: r.COLUMN_DEFAULT,
      key: r.COLUMN_KEY,
    });
    byTable.set(r.TABLE_NAME, arr);
  }
  return byTable;
}

async function listIndexes(
  connection: string,
  db: string,
  tables: string[],
): Promise<Map<string, IndexDef[]>> {
  const rows = await queryWithTimeout<IndexRow[]>(
    connection,
    `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME,
            NON_UNIQUE, INDEX_TYPE
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME IN (${inListPlaceholders(tables)})
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [db, ...tables],
  );
  // Group by (table, index name) since each multi-column index spans rows
  const acc = new Map<string, Map<string, IndexDef>>();
  for (const r of rows) {
    const tableIdxs = acc.get(r.TABLE_NAME) ?? new Map<string, IndexDef>();
    const existing = tableIdxs.get(r.INDEX_NAME);
    if (existing) {
      existing.columns.push(r.COLUMN_NAME);
    } else {
      tableIdxs.set(r.INDEX_NAME, {
        name: r.INDEX_NAME,
        columns: [r.COLUMN_NAME],
        unique: r.NON_UNIQUE === 0,
        type: r.INDEX_TYPE,
      });
    }
    acc.set(r.TABLE_NAME, tableIdxs);
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
  const rows = await queryWithTimeout<FKRow[]>(
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
       AND kcu.TABLE_NAME IN (${inListPlaceholders(tables)})
     ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    [db, ...tables],
  );
  // Group by (table, constraint name) for composite-FK support.
  const acc = new Map<string, Map<string, ForeignKey>>();
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
  const out = new Map<string, ForeignKey[]>();
  for (const [t, map] of acc) out.set(t, [...map.values()]);
  return out;
}

// ── Diff types + functions ──────────────────────────────────────────

interface ColumnDiff {
  onlyInSource: Column[];
  onlyInTarget: Column[];
  modified: Array<{ name: string; source: Column; target: Column; diffs: string[] }>;
}

interface IndexDiff {
  onlyInSource: IndexDef[];
  onlyInTarget: IndexDef[];
  modified: Array<{
    name: string;
    source: IndexDef;
    target: IndexDef;
    diffs: string[];
  }>;
}

interface FKDiff {
  onlyInSource: ForeignKey[];
  onlyInTarget: ForeignKey[];
  modified: Array<{
    name: string;
    source: ForeignKey;
    target: ForeignKey;
    diffs: string[];
  }>;
}

function diffHasContent(d: { onlyInSource: unknown[]; onlyInTarget: unknown[]; modified: unknown[] }): boolean {
  return d.onlyInSource.length > 0 || d.onlyInTarget.length > 0 || d.modified.length > 0;
}

export function diffColumns(srcCols: Column[], tgtCols: Column[]): ColumnDiff {
  const srcMap = new Map(srcCols.map((c) => [c.name, c]));
  const tgtMap = new Map(tgtCols.map((c) => [c.name, c]));
  const result: ColumnDiff = { onlyInSource: [], onlyInTarget: [], modified: [] };

  for (const [name, src] of srcMap) {
    const tgt = tgtMap.get(name);
    if (!tgt) {
      result.onlyInSource.push(src);
      continue;
    }
    const diffs: string[] = [];
    if (src.type !== tgt.type) diffs.push(`type: ${src.type} → ${tgt.type}`);
    if (src.nullable !== tgt.nullable)
      diffs.push(`nullable: ${src.nullable} → ${tgt.nullable}`);
    if (src.default !== tgt.default)
      diffs.push(`default: ${formatDefault(src.default)} → ${formatDefault(tgt.default)}`);
    if (src.key !== tgt.key) diffs.push(`key: ${src.key || "(none)"} → ${tgt.key || "(none)"}`);
    if (diffs.length > 0) result.modified.push({ name, source: src, target: tgt, diffs });
  }
  for (const [name, tgt] of tgtMap) {
    if (!srcMap.has(name)) result.onlyInTarget.push(tgt);
  }
  result.onlyInSource.sort((a, b) => a.name.localeCompare(b.name));
  result.onlyInTarget.sort((a, b) => a.name.localeCompare(b.name));
  result.modified.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function diffIndexes(srcIdx: IndexDef[], tgtIdx: IndexDef[]): IndexDiff {
  const srcMap = new Map(srcIdx.map((i) => [i.name, i]));
  const tgtMap = new Map(tgtIdx.map((i) => [i.name, i]));
  const result: IndexDiff = { onlyInSource: [], onlyInTarget: [], modified: [] };

  for (const [name, src] of srcMap) {
    const tgt = tgtMap.get(name);
    if (!tgt) {
      result.onlyInSource.push(src);
      continue;
    }
    const diffs: string[] = [];
    if (src.columns.join(",") !== tgt.columns.join(","))
      diffs.push(`columns: (${src.columns.join(",")}) → (${tgt.columns.join(",")})`);
    if (src.unique !== tgt.unique) diffs.push(`unique: ${src.unique} → ${tgt.unique}`);
    if (src.type !== tgt.type) diffs.push(`type: ${src.type} → ${tgt.type}`);
    if (diffs.length > 0) result.modified.push({ name, source: src, target: tgt, diffs });
  }
  for (const [name, tgt] of tgtMap) {
    if (!srcMap.has(name)) result.onlyInTarget.push(tgt);
  }
  result.onlyInSource.sort((a, b) => a.name.localeCompare(b.name));
  result.onlyInTarget.sort((a, b) => a.name.localeCompare(b.name));
  result.modified.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function diffForeignKeys(srcFK: ForeignKey[], tgtFK: ForeignKey[]): FKDiff {
  const srcMap = new Map(srcFK.map((f) => [f.name, f]));
  const tgtMap = new Map(tgtFK.map((f) => [f.name, f]));
  const result: FKDiff = { onlyInSource: [], onlyInTarget: [], modified: [] };

  for (const [name, src] of srcMap) {
    const tgt = tgtMap.get(name);
    if (!tgt) {
      result.onlyInSource.push(src);
      continue;
    }
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
    if (diffs.length > 0) result.modified.push({ name, source: src, target: tgt, diffs });
  }
  for (const [name, tgt] of tgtMap) {
    if (!srcMap.has(name)) result.onlyInTarget.push(tgt);
  }
  result.onlyInSource.sort((a, b) => a.name.localeCompare(b.name));
  result.onlyInTarget.sort((a, b) => a.name.localeCompare(b.name));
  result.modified.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatDefault(d: string | null): string {
  if (d === null) return "NULL";
  return `'${d}'`;
}

function sumAcross<T>(map: Map<string, T>, pick: (v: T) => number): number {
  let total = 0;
  for (const v of map.values()) total += pick(v);
  return total;
}

// ── Markdown rendering ──────────────────────────────────────────────

interface RenderInput {
  source: { connection: string; database: string };
  target: { connection: string; database: string };
  scope: Scope[];
  tables: { onlyInSource: string[]; onlyInTarget: string[]; shared: string[] };
  details: Array<{
    table: string;
    columns?: ColumnDiff | undefined;
    indexes?: IndexDiff | undefined;
    foreignKeys?: FKDiff | undefined;
  }>;
  summary: {
    tablesOnlyInSource: number;
    tablesOnlyInTarget: number;
    tablesShared: number;
    tablesModified: number;
    columnsAdded: number;
    columnsRemoved: number;
    columnsModified: number;
    indexesAdded: number;
    indexesRemoved: number;
    indexesModified: number;
    fksAdded: number;
    fksRemoved: number;
    fksModified: number;
    inSync: boolean;
  };
}

function renderMarkdown(r: RenderInput): string {
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

  out.push("## Summary");
  out.push("");
  out.push(`- Tables only in source: ${r.summary.tablesOnlyInSource}`);
  out.push(`- Tables only in target: ${r.summary.tablesOnlyInTarget}`);
  out.push(`- Tables shared: ${r.summary.tablesShared}`);
  out.push(`- Tables with differences: ${r.summary.tablesModified}`);
  if (
    r.summary.columnsAdded + r.summary.columnsRemoved + r.summary.columnsModified >
    0
  )
    out.push(
      `- Columns: +${r.summary.columnsAdded} / -${r.summary.columnsRemoved} / ~${r.summary.columnsModified}`,
    );
  if (
    r.summary.indexesAdded + r.summary.indexesRemoved + r.summary.indexesModified >
    0
  )
    out.push(
      `- Indexes: +${r.summary.indexesAdded} / -${r.summary.indexesRemoved} / ~${r.summary.indexesModified}`,
    );
  if (r.summary.fksAdded + r.summary.fksRemoved + r.summary.fksModified > 0)
    out.push(
      `- Foreign keys: +${r.summary.fksAdded} / -${r.summary.fksRemoved} / ~${r.summary.fksModified}`,
    );

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

  if (r.details.length > 0) {
    out.push("");
    out.push("## Modified tables");
    for (const d of r.details) {
      out.push("");
      out.push(`### \`${d.table}\``);
      if (d.columns) {
        out.push("");
        out.push("**Columns**");
        for (const c of d.columns.onlyInSource)
          out.push(`- only in source: \`${c.name}\` ${c.type}`);
        for (const c of d.columns.onlyInTarget)
          out.push(`- only in target: \`${c.name}\` ${c.type}`);
        for (const m of d.columns.modified)
          out.push(`- modified \`${m.name}\`: ${m.diffs.join("; ")}`);
      }
      if (d.indexes) {
        out.push("");
        out.push("**Indexes**");
        for (const i of d.indexes.onlyInSource)
          out.push(
            `- only in source: \`${i.name}\` (${i.columns.join(",")})${i.unique ? " UNIQUE" : ""}`,
          );
        for (const i of d.indexes.onlyInTarget)
          out.push(
            `- only in target: \`${i.name}\` (${i.columns.join(",")})${i.unique ? " UNIQUE" : ""}`,
          );
        for (const m of d.indexes.modified)
          out.push(`- modified \`${m.name}\`: ${m.diffs.join("; ")}`);
      }
      if (d.foreignKeys) {
        out.push("");
        out.push("**Foreign keys**");
        for (const f of d.foreignKeys.onlyInSource)
          out.push(
            `- only in source: \`${f.name}\` (${f.columns.join(",")}) → ${f.referencedTable}(${f.referencedColumns.join(",")})`,
          );
        for (const f of d.foreignKeys.onlyInTarget)
          out.push(
            `- only in target: \`${f.name}\` (${f.columns.join(",")}) → ${f.referencedTable}(${f.referencedColumns.join(",")})`,
          );
        for (const m of d.foreignKeys.modified)
          out.push(`- modified \`${m.name}\`: ${m.diffs.join("; ")}`);
      }
    }
  }

  return out.join("\n");
}

// Export pure functions for unit tests
export type { Column, IndexDef, ForeignKey, ColumnDiff, IndexDiff, FKDiff };

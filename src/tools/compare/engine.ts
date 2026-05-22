/**
 * Shared engine for schema comparison.
 *
 * Both `compare_schemas` (two live databases) and `compare_schema_file`
 * (a checked-in `.sql` file vs a live database) call into here. They
 * differ only in how they obtain the source side — once we have two
 * (connection, database) tuples, the orchestration is identical.
 *
 * This file is the single source of truth for the comparison flow:
 * scope gating, per-phase fetcher → diff → aggregation, progress
 * emission, cancellation between phases, and the structured response
 * shape. The tool entry points stay thin wrappers around it.
 */

import {
  toolOk,
  toolError,
  emitProgress,
  type ToolExtra,
  type ToolResult,
} from "../../tool-runtime.js";
import type {
  ColumnDiff,
  IndexDiff,
  FKDiff,
  TableAttrDiff,
  ViewDiff,
  RoutineDiff,
  TriggerDiff,
  EventDiff,
} from "../../types/db.js";
import { SCOPES, type Scope } from "./scope.js";
import { diffHasContent, emptyDiff, sumAcross } from "./normalize.js";
import {
  listColumns,
  listEvents,
  listForeignKeys,
  listIndexes,
  listRoutines,
  listTableAttributes,
  listTables,
  listTriggers,
  listViews,
} from "./fetchers.js";
import {
  diffColumns,
  diffEvents,
  diffForeignKeys,
  diffIndexes,
  diffRoutines,
  diffTableAttributes,
  diffTriggers,
  diffViews,
} from "./diff.js";
import { renderMarkdown } from "./render.js";

export interface SchemaComparisonOpts {
  sourceConnection: string;
  /** Already resolved — `resolveDb` happens at the tool boundary, not here. */
  sourceDatabase: string;
  targetConnection: string;
  /** Already resolved — `resolveDb` happens at the tool boundary, not here. */
  targetDatabase: string;
  tableFilter?: readonly string[] | undefined;
  scope?: readonly Scope[] | undefined;
  summaryOnly?: boolean | undefined;
  extra?: ToolExtra | undefined;
  /**
   * Override the label written into the response's `source.connection`
   * field. compare_schema_file uses this to show the file path instead
   * of a scratch-DB name — the agent shouldn't have to think about the
   * scaffolding that made the comparison possible.
   */
  sourceLabel?: string;
}

export async function runSchemaComparison(
  opts: SchemaComparisonOpts,
): Promise<ToolResult> {
  const {
    sourceConnection,
    sourceDatabase,
    targetConnection,
    targetDatabase,
    tableFilter,
    scope,
    summaryOnly,
    extra,
    sourceLabel,
  } = opts;

  const scopes: Scope[] = scope && scope.length > 0 ? [...scope] : [...SCOPES];
  const want = (s: Scope): boolean => scopes.includes(s);

  // Honor client-side cancellation. Checked between each scope —
  // mid-scope cancellation would orphan in-flight queries.
  const aborted = (): boolean => extra?.signal?.aborted === true;
  if (aborted()) return toolError("Request cancelled before execution.");

  const totalSteps = scopes.length;
  let step = 0;
  const tick = async (label: string): Promise<void> => {
    step += 1;
    await emitProgress(extra, step, totalSteps, label);
  };

  // ── Phase 1: Tables ─────────────────────────────────────────
  await emitProgress(extra, 0, totalSteps, "Listing tables");

  const [srcTables, tgtTables] = await Promise.all([
    listTables(sourceConnection, sourceDatabase),
    listTables(targetConnection, targetDatabase),
  ]);

  const filter =
    tableFilter && tableFilter.length > 0 ? new Set(tableFilter) : null;
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
      listTableAttributes(sourceConnection, sourceDatabase, sharedNames),
      listTableAttributes(targetConnection, targetDatabase, sharedNames),
    ]);
    Object.assign(tableAttrDiff, diffTableAttributes(srcAttrs, tgtAttrs));
    await tick("Compared table attributes");
    if (aborted())
      return toolError("Request cancelled during tableAttributes phase.");
  }

  if (want("columns") && sharedNames) {
    const [srcCols, tgtCols] = await Promise.all([
      listColumns(sourceConnection, sourceDatabase, sharedNames),
      listColumns(targetConnection, targetDatabase, sharedNames),
    ]);
    for (const t of sharedNames) {
      const diff = diffColumns(srcCols.get(t) ?? [], tgtCols.get(t) ?? []);
      if (diffHasContent(diff)) colDiffs.set(t, diff);
    }
    await tick("Compared columns");
    if (aborted())
      return toolError("Request cancelled during columns phase.");
  }

  if (want("indexes") && sharedNames) {
    const [srcIdx, tgtIdx] = await Promise.all([
      listIndexes(sourceConnection, sourceDatabase, sharedNames),
      listIndexes(targetConnection, targetDatabase, sharedNames),
    ]);
    for (const t of sharedNames) {
      const diff = diffIndexes(srcIdx.get(t) ?? [], tgtIdx.get(t) ?? []);
      if (diffHasContent(diff)) idxDiffs.set(t, diff);
    }
    await tick("Compared indexes");
    if (aborted())
      return toolError("Request cancelled during indexes phase.");
  }

  if (want("foreignKeys") && sharedNames) {
    const [srcFK, tgtFK] = await Promise.all([
      listForeignKeys(sourceConnection, sourceDatabase, sharedNames),
      listForeignKeys(targetConnection, targetDatabase, sharedNames),
    ]);
    for (const t of sharedNames) {
      const diff = diffForeignKeys(srcFK.get(t) ?? [], tgtFK.get(t) ?? []);
      if (diffHasContent(diff)) fkDiffs.set(t, diff);
    }
    await tick("Compared foreign keys");
    if (aborted())
      return toolError("Request cancelled during foreignKeys phase.");
  }

  if (want("views")) {
    const [srcViews, tgtViews] = await Promise.all([
      listViews(sourceConnection, sourceDatabase),
      listViews(targetConnection, targetDatabase),
    ]);
    viewDiff = diffViews(srcViews, tgtViews);
    await tick("Compared views");
    if (aborted())
      return toolError("Request cancelled during views phase.");
  }

  if (want("routines")) {
    const [srcRoutines, tgtRoutines] = await Promise.all([
      listRoutines(sourceConnection, sourceDatabase),
      listRoutines(targetConnection, targetDatabase),
    ]);
    routineDiff = diffRoutines(srcRoutines, tgtRoutines);
    await tick("Compared routines");
    if (aborted())
      return toolError("Request cancelled during routines phase.");
  }

  if (want("triggers")) {
    const [srcTrig, tgtTrig] = await Promise.all([
      listTriggers(sourceConnection, sourceDatabase),
      listTriggers(targetConnection, targetDatabase),
    ]);
    triggerDiff = diffTriggers(srcTrig, tgtTrig);
    await tick("Compared triggers");
    if (aborted())
      return toolError("Request cancelled during triggers phase.");
  }

  if (want("events")) {
    const [srcEvents, tgtEvents] = await Promise.all([
      listEvents(sourceConnection, sourceDatabase),
      listEvents(targetConnection, targetDatabase),
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
          attributes: tableAttrDiff.modified.find((m) => m.name === table)
            ?.diffs,
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
    source: { connection: sourceLabel ?? sourceConnection, database: sourceDatabase },
    target: { connection: targetConnection, database: targetDatabase },
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
}

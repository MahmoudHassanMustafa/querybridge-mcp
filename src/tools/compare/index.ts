import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveDb } from "../../db/resolve.js";
import {
  toolOk,
  toolError,
  toolHandler,
  emitProgress,
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

/**
 * compare_schemas tool — orchestrator.
 *
 * For each requested scope (tables, columns, indexes, FKs, views,
 * routines, triggers, events) the flow is the same:
 *
 *   fetchers (./fetchers.ts)
 *      → diff   (./diff.ts)
 *      → render (./render.ts)
 *
 * This file owns only the orchestration: schema validation, scope
 * gating, cancellation between phases, summary aggregation, and the
 * tool's structured response shape.
 */

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
          listTables(sourceConnection, src.db),
          listTables(targetConnection, tgt.db),
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
        if (aborted())
          return toolError("Request cancelled after table listing.");

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
          if (aborted())
            return toolError("Request cancelled during tableAttributes phase.");
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
          if (aborted())
            return toolError("Request cancelled during columns phase.");
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
          if (aborted())
            return toolError("Request cancelled during indexes phase.");
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
          if (aborted())
            return toolError("Request cancelled during foreignKeys phase.");
        }

        if (want("views")) {
          const [srcViews, tgtViews] = await Promise.all([
            listViews(sourceConnection, src.db),
            listViews(targetConnection, tgt.db),
          ]);
          viewDiff = diffViews(srcViews, tgtViews);
          await tick("Compared views");
          if (aborted())
            return toolError("Request cancelled during views phase.");
        }

        if (want("routines")) {
          const [srcRoutines, tgtRoutines] = await Promise.all([
            listRoutines(sourceConnection, src.db),
            listRoutines(targetConnection, tgt.db),
          ]);
          routineDiff = diffRoutines(srcRoutines, tgtRoutines);
          await tick("Compared routines");
          if (aborted())
            return toolError("Request cancelled during routines phase.");
        }

        if (want("triggers")) {
          const [srcTrig, tgtTrig] = await Promise.all([
            listTriggers(sourceConnection, src.db),
            listTriggers(targetConnection, tgt.db),
          ]);
          triggerDiff = diffTriggers(srcTrig, tgtTrig);
          await tick("Compared triggers");
          if (aborted())
            return toolError("Request cancelled during triggers phase.");
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

// ── Test surface ───────────────────────────────────────────────────
// The existing compare-tools.test.ts imports diff functions, the
// __test bundle of internal utilities, and the shared domain types.
// Re-export them from this barrel so the test file stays a single import.

export {
  diffColumns,
  diffIndexes,
  diffForeignKeys,
  diffTableAttributes,
  diffViews,
  diffRoutines,
  diffTriggers,
  diffEvents,
} from "./diff.js";

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
} from "../../types/db.js";

import { normalizeType, normalizeSQL, chunkArray } from "./normalize.js";
export const __test = { normalizeType, normalizeSQL, chunkArray };

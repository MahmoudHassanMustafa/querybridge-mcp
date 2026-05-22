import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveDb } from "../../db/resolve.js";
import { toolHandler } from "../../tool-runtime.js";
import { SCOPES } from "./scope.js";
import { runSchemaComparison } from "./engine.js";

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

        return runSchemaComparison({
          sourceConnection,
          sourceDatabase: src.db,
          targetConnection,
          targetDatabase: tgt.db,
          tableFilter,
          scope,
          summaryOnly,
          extra,
        });
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

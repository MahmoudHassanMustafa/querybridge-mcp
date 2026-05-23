/**
 * `generate_migration` — advisory-only ALTER/CREATE/DROP SQL generator.
 *
 * Takes two schemas (source = desired state, target = the DB to modify)
 * and emits the SQL statements that, **if applied to target**, would
 * align it with source. **NEVER executes the SQL.** The output is
 * text + structured content for the operator to review and run
 * manually after careful inspection.
 *
 * Safety model:
 *   - Tool is read-only at the MCP boundary (the annotation says so).
 *     We don't open a writable connection to the target side.
 *   - Destructive operations (DROP TABLE / COLUMN / FK / INDEX, column
 *     modifies that can truncate) are **opt-in** via explicit flags.
 *     Without them, the migration covers only additive changes.
 *   - Every destructive SQL line is preceded by a `-- WARNING:` SQL
 *     comment so an operator copy-pasting one statement at a time
 *     still sees the risk.
 *   - The whole output is wrapped in a banner stating "do not execute
 *     blindly" — operators see it before any individual statement.
 *
 * V1 scope (documented):
 *   - Tables (CREATE / DROP — the latter behind include_drops).
 *   - Columns (ADD / DROP / MODIFY — drops + modifies behind their
 *     respective flags).
 *   - Indexes (ADD / DROP — drops behind include_drops).
 *   - Foreign keys (ADD / DROP — drops behind include_drops).
 *   - Skipped (called out in the response with `unsupported_changes`):
 *     views, routines, triggers, events, table attribute changes
 *     (engine, charset, partitioning), and column type narrowing
 *     beyond a basic warning.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveDb } from "../db/resolve.js";
import { runSchemaComparison } from "./compare/engine.js";
import {
  listColumns,
  listForeignKeys,
  listIndexes,
} from "./compare/fetchers.js";
import { getCreateTable } from "../db/introspection.js";
import { escapeId, qualifiedTable } from "../sql/identifiers.js";
import {
  toolHandler,
  toolOk,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../tool-runtime.js";
import type { Column, ForeignKey, IndexDef } from "../types/db.js";

// ── DDL helpers ────────────────────────────────────────────────────

/**
 * Render a single Column object as the column-definition fragment
 * that can appear in `ADD COLUMN`, `MODIFY COLUMN`, or inside a
 * `CREATE TABLE` body.
 *
 * Generated columns produce `<name> <type> GENERATED ALWAYS AS (expr)
 * [VIRTUAL|STORED]`. Regular columns include NOT NULL, DEFAULT, EXTRA
 * (e.g. AUTO_INCREMENT), and COMMENT.
 *
 * V1 limitation: doesn't emit explicit CHARACTER SET / COLLATE clauses
 * even when the column overrides the table default. Most schemas don't
 * need per-column overrides; the rare cases that do should review the
 * output and add them manually.
 */
function columnDdl(col: Column): string {
  const parts: string[] = [escapeId(col.name), col.type];
  if (col.generationExpression) {
    const storage = /\bSTORED\b/i.test(col.extra) ? "STORED" : "VIRTUAL";
    parts.push(`GENERATED ALWAYS AS (${col.generationExpression}) ${storage}`);
  }
  if (!col.nullable) parts.push("NOT NULL");
  if (col.default !== null) {
    // CURRENT_TIMESTAMP and CURRENT_TIMESTAMP(N) are SQL functions, not
    // literal strings — emit them verbatim. Everything else gets
    // single-quoted with embedded-quote doubling.
    const isTimestampFn = /^CURRENT_TIMESTAMP(\(\d*\))?$/i.test(col.default);
    parts.push(
      `DEFAULT ${isTimestampFn ? col.default : `'${col.default.replace(/'/g, "''")}'`}`,
    );
  }
  if (col.extra && !/GENERATED|VIRTUAL|STORED/i.test(col.extra)) {
    parts.push(col.extra);
  }
  if (col.comment) {
    parts.push(`COMMENT '${col.comment.replace(/'/g, "''")}'`);
  }
  return parts.join(" ");
}

function indexDdl(idx: IndexDef): string {
  const cols = idx.columns
    .map((c, i) => {
      // Functional index: expression replaces the column reference.
      const expr = idx.expressions?.[i];
      if (expr) return `(${expr})`;
      const subPart = idx.subParts?.[i];
      return subPart != null ? `${escapeId(c)}(${subPart})` : escapeId(c);
    })
    .join(", ");
  const uniqueClause = idx.unique ? "UNIQUE " : "";
  const typeClause =
    idx.type && idx.type !== "BTREE" ? ` USING ${idx.type}` : "";
  const visibility = idx.visible === false ? " INVISIBLE" : "";
  return `${uniqueClause}INDEX ${escapeId(idx.name)} (${cols})${typeClause}${visibility}`;
}

function fkConstraintDdl(fk: ForeignKey): string {
  const cols = fk.columns.map(escapeId).join(", ");
  const refCols = fk.referencedColumns.map(escapeId).join(", ");
  return `CONSTRAINT ${escapeId(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${escapeId(fk.referencedTable)} (${refCols}) ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`;
}

// ── statement emitter ─────────────────────────────────────────────

/** Phase order matters for safe application — earlier phases unlock later ones. */
type Phase =
  | "drop_fks"
  | "drop_indexes"
  | "drop_columns"
  | "modify_columns"
  | "add_columns"
  | "add_indexes"
  | "add_fks"
  | "drop_tables"
  | "add_tables";

interface MigrationStatement {
  phase: Phase;
  table: string;
  sql: string;
  /** Empty when the statement is purely additive. */
  warnings: string[];
  /** One-line human description for the rendered text body. */
  description: string;
}

// ── handler ────────────────────────────────────────────────────────

interface GenerateMigrationArgs {
  sourceConnection: string;
  sourceDatabase?: string | undefined;
  targetConnection: string;
  targetDatabase?: string | undefined;
  tables?: string[] | undefined;
  include_drops?: boolean | undefined;
  include_destructive_changes?: boolean | undefined;
  [key: string]: unknown;
}

export const handleGenerateMigration = toolHandler<GenerateMigrationArgs>(
  "generate_migration",
  async ({
    sourceConnection,
    sourceDatabase,
    targetConnection,
    targetDatabase,
    tables: tableFilter,
    include_drops: includeDrops,
    include_destructive_changes: includeDestructive,
  }) => {
    const src = resolveDb(sourceConnection, sourceDatabase);
    if ("error" in src) return src.error;
    const tgt = resolveDb(targetConnection, targetDatabase);
    if ("error" in tgt) return tgt.error;

    // Reuse the same comparison engine compare_schemas uses. The diff
    // gives us per-table column/index/FK changes plus the only-in-X
    // table lists.
    const diffResult = await runSchemaComparison({
      sourceConnection,
      sourceDatabase: src.db,
      targetConnection,
      targetDatabase: tgt.db,
      tableFilter,
      // Skip programmability + table-attribute scopes — V1 doesn't
      // emit migration SQL for those.
      scope: ["tables", "columns", "indexes", "foreignKeys"],
    });
    if ("isError" in diffResult && diffResult.isError) {
      return diffResult; // bubble up: connection error, resolve error, etc.
    }
    const diff = diffResult.structuredContent as {
      tables: {
        onlyInSource: string[];
        onlyInTarget: string[];
        shared: string[];
      };
      details: Array<{
        table: string;
        columns?: {
          onlyInSource: Column[];
          onlyInTarget: Column[];
          modified: Array<{ name: string; diffs: string[] }>;
        };
        indexes?: {
          onlyInSource: IndexDef[];
          onlyInTarget: IndexDef[];
          modified: Array<{ name: string; diffs: string[] }>;
        };
        foreignKeys?: {
          onlyInSource: ForeignKey[];
          onlyInTarget: ForeignKey[];
          modified: Array<{ name: string; diffs: string[] }>;
        };
      }>;
    };

    const statements: MigrationStatement[] = [];

    // ── Phase 1: drop FKs in target (so we can modify referenced things) ──
    if (includeDrops) {
      for (const d of diff.details) {
        for (const fk of d.foreignKeys?.onlyInTarget ?? []) {
          statements.push({
            phase: "drop_fks",
            table: d.table,
            sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} DROP FOREIGN KEY ${escapeId(fk.name)};`,
            warnings: ["FK constraint removed — orphan rows become possible."],
            description: `Drop FK ${fk.name} from ${d.table}`,
          });
        }
        // Modified FKs: drop the old constraint and add the new one
        // in the add_fks phase (handled below).
        if (includeDestructive) {
          for (const mod of d.foreignKeys?.modified ?? []) {
            statements.push({
              phase: "drop_fks",
              table: d.table,
              sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} DROP FOREIGN KEY ${escapeId(mod.name)};`,
              warnings: [
                `FK ${mod.name} changed: ${mod.diffs.join(", ")}. Old constraint dropped here; new one added in the FK-add phase.`,
              ],
              description: `Drop FK ${mod.name} (will be re-added)`,
            });
          }
        }
      }
    }

    // ── Phase 2: drop indexes ──
    if (includeDrops) {
      for (const d of diff.details) {
        for (const idx of d.indexes?.onlyInTarget ?? []) {
          // PRIMARY KEY drops need different syntax — usually you
          // wouldn't want to drop a primary key without a redesign,
          // so we comment it out for manual review.
          if (idx.name === "PRIMARY") {
            statements.push({
              phase: "drop_indexes",
              table: d.table,
              sql: `-- ALTER TABLE ${qualifiedTable(tgt.db, d.table)} DROP PRIMARY KEY;  -- COMMENTED: dropping a PK is rarely correct; review the schema redesign instead.`,
              warnings: ["Primary key drop intentionally commented out."],
              description: `Drop PRIMARY KEY on ${d.table} (commented out)`,
            });
            continue;
          }
          statements.push({
            phase: "drop_indexes",
            table: d.table,
            sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} DROP INDEX ${escapeId(idx.name)};`,
            warnings: [
              "Query plans on this table may slow until a replacement is added.",
            ],
            description: `Drop index ${idx.name} from ${d.table}`,
          });
        }
        if (includeDestructive) {
          for (const mod of d.indexes?.modified ?? []) {
            if (mod.name === "PRIMARY") continue;
            statements.push({
              phase: "drop_indexes",
              table: d.table,
              sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} DROP INDEX ${escapeId(mod.name)};`,
              warnings: [
                `Index ${mod.name} changed: ${mod.diffs.join(", ")}. Old definition dropped here; new one added in the index-add phase.`,
              ],
              description: `Drop index ${mod.name} (will be re-added)`,
            });
          }
        }
      }
    }

    // ── Phase 3: drop columns ──
    if (includeDrops) {
      for (const d of diff.details) {
        for (const col of d.columns?.onlyInTarget ?? []) {
          statements.push({
            phase: "drop_columns",
            table: d.table,
            sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} DROP COLUMN ${escapeId(col.name)};`,
            warnings: [
              `DESTRUCTIVE: column ${col.name} (${col.type}) will be removed along with all its data.`,
            ],
            description: `Drop column ${col.name} from ${d.table}`,
          });
        }
      }
    }

    // ── Phase 4: modify columns (re-fetch source defs) ──
    // Modified columns need the source's full Column spec to emit the
    // new MODIFY COLUMN clause. The diff result only carries the name +
    // a description of what changed; fetch the source side directly
    // for the tables that have modifications.
    if (includeDestructive) {
      const tablesWithColMods = diff.details
        .filter((d) => (d.columns?.modified.length ?? 0) > 0)
        .map((d) => d.table);
      if (tablesWithColMods.length > 0) {
        const srcCols = await listColumns(
          sourceConnection,
          src.db,
          tablesWithColMods,
        );
        for (const d of diff.details) {
          const mods = d.columns?.modified ?? [];
          if (mods.length === 0) continue;
          const srcForTable = srcCols.get(d.table) ?? [];
          const byName = new Map(srcForTable.map((c) => [c.name, c]));
          for (const mod of mods) {
            const sourceCol = byName.get(mod.name);
            if (!sourceCol) continue;
            const typeChangeWarning = mod.diffs.find((d) =>
              d.startsWith("type:"),
            );
            statements.push({
              phase: "modify_columns",
              table: d.table,
              sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} MODIFY COLUMN ${columnDdl(sourceCol)};`,
              warnings: [
                `Changes: ${mod.diffs.join(", ")}`,
                ...(typeChangeWarning
                  ? [
                      "Type change can cause silent data truncation on narrowing (VARCHAR(255) → VARCHAR(64), INT → SMALLINT, etc.). Validate before applying.",
                    ]
                  : []),
              ],
              description: `Modify ${d.table}.${mod.name}`,
            });
          }
        }
      }
    }

    // ── Phase 5: add columns (always additive — no flag gate) ──
    for (const d of diff.details) {
      for (const col of d.columns?.onlyInSource ?? []) {
        statements.push({
          phase: "add_columns",
          table: d.table,
          sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} ADD COLUMN ${columnDdl(col)};`,
          warnings:
            !col.nullable && col.default === null
              ? [
                  `Column is NOT NULL with no DEFAULT — existing rows will fail unless backfilled first. Consider adding the column NULL, backfilling, then setting NOT NULL.`,
                ]
              : [],
          description: `Add column ${col.name} to ${d.table}`,
        });
      }
    }

    // ── Phase 6: add indexes ──
    for (const d of diff.details) {
      for (const idx of d.indexes?.onlyInSource ?? []) {
        if (idx.name === "PRIMARY") {
          statements.push({
            phase: "add_indexes",
            table: d.table,
            sql: `-- ALTER TABLE ${qualifiedTable(tgt.db, d.table)} ADD PRIMARY KEY (${idx.columns.map(escapeId).join(", ")});  -- COMMENTED: adding a PK on an existing table is rarely correct; review the schema redesign.`,
            warnings: ["Primary key add intentionally commented out."],
            description: `Add PRIMARY KEY on ${d.table} (commented out)`,
          });
          continue;
        }
        statements.push({
          phase: "add_indexes",
          table: d.table,
          sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} ADD ${indexDdl(idx)};`,
          warnings: [],
          description: `Add index ${idx.name} to ${d.table}`,
        });
      }
      if (includeDestructive) {
        for (const mod of d.indexes?.modified ?? []) {
          if (mod.name === "PRIMARY") continue;
          // The new definition comes from source — re-fetch the
          // source's IndexDef for this table to get the structured form.
          // (Done in a single re-fetch block below to keep the loop
          // simple.)
        }
      }
    }
    if (includeDestructive) {
      const tablesWithIdxMods = diff.details
        .filter((d) => (d.indexes?.modified.length ?? 0) > 0)
        .map((d) => d.table);
      if (tablesWithIdxMods.length > 0) {
        const srcIdx = await listIndexes(
          sourceConnection,
          src.db,
          tablesWithIdxMods,
        );
        for (const d of diff.details) {
          const mods = d.indexes?.modified ?? [];
          for (const mod of mods) {
            if (mod.name === "PRIMARY") continue;
            const srcList = srcIdx.get(d.table) ?? [];
            const sourceIdx = srcList.find((i) => i.name === mod.name);
            if (!sourceIdx) continue;
            statements.push({
              phase: "add_indexes",
              table: d.table,
              sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} ADD ${indexDdl(sourceIdx)};`,
              warnings: [
                `Re-creating index ${mod.name} with new definition: ${mod.diffs.join(", ")}.`,
              ],
              description: `Re-add index ${mod.name} on ${d.table}`,
            });
          }
        }
      }
    }

    // ── Phase 7: add FKs (after both tables exist + columns/indexes are in place) ──
    for (const d of diff.details) {
      for (const fk of d.foreignKeys?.onlyInSource ?? []) {
        statements.push({
          phase: "add_fks",
          table: d.table,
          sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} ADD ${fkConstraintDdl(fk)};`,
          warnings: [
            "Adding an FK can fail if existing rows have referencing values not present in the parent. Validate referential integrity first.",
          ],
          description: `Add FK ${fk.name} to ${d.table}`,
        });
      }
    }
    if (includeDestructive) {
      const tablesWithFkMods = diff.details
        .filter((d) => (d.foreignKeys?.modified.length ?? 0) > 0)
        .map((d) => d.table);
      if (tablesWithFkMods.length > 0) {
        const srcFk = await listForeignKeys(
          sourceConnection,
          src.db,
          tablesWithFkMods,
        );
        for (const d of diff.details) {
          for (const mod of d.foreignKeys?.modified ?? []) {
            const srcList = srcFk.get(d.table) ?? [];
            const sourceFk = srcList.find((f) => f.name === mod.name);
            if (!sourceFk) continue;
            statements.push({
              phase: "add_fks",
              table: d.table,
              sql: `ALTER TABLE ${qualifiedTable(tgt.db, d.table)} ADD ${fkConstraintDdl(sourceFk)};`,
              warnings: [
                `Re-creating FK ${mod.name} with new definition: ${mod.diffs.join(", ")}.`,
              ],
              description: `Re-add FK ${mod.name} on ${d.table}`,
            });
          }
        }
      }
    }

    // ── Phase 8: drop tables (after their FKs are gone) ──
    if (includeDrops) {
      for (const t of diff.tables.onlyInTarget) {
        statements.push({
          phase: "drop_tables",
          table: t,
          sql: `DROP TABLE ${qualifiedTable(tgt.db, t)};`,
          warnings: [
            `DESTRUCTIVE: table ${t} and all its rows will be removed permanently.`,
          ],
          description: `Drop table ${t}`,
        });
      }
    }

    // ── Phase 9: add tables (CREATE TABLE from source) ──
    for (const t of diff.tables.onlyInSource) {
      const ddl = await getCreateTable(sourceConnection, src.db, t);
      if (!ddl) continue;
      statements.push({
        phase: "add_tables",
        table: t,
        sql: ddl.trim().endsWith(";") ? ddl.trim() : `${ddl.trim()};`,
        warnings: [],
        description: `Create table ${t}`,
      });
    }

    // ── Render ────────────────────────────────────────────────────────
    const banner = [
      "=".repeat(80),
      "⚠ ADVISORY MIGRATION SQL — DO NOT EXECUTE BLINDLY",
      "=".repeat(80),
      "querybridge-mcp does NOT execute these statements. Before applying:",
      "  1. Review every statement for data-loss risk.",
      "  2. Verify source/target direction is correct.",
      "  3. Run in a transaction or back up target first.",
      "  4. Test on staging before production.",
      "=".repeat(80),
    ].join("\n");

    const summary = {
      source: { connection: sourceConnection, database: src.db },
      target: { connection: targetConnection, database: tgt.db },
      tables_added: diff.tables.onlyInSource.length,
      tables_dropped: includeDrops ? diff.tables.onlyInTarget.length : 0,
      tables_dropped_skipped: !includeDrops
        ? diff.tables.onlyInTarget.length
        : 0,
      columns_added: statements.filter((s) => s.phase === "add_columns").length,
      columns_dropped: statements.filter((s) => s.phase === "drop_columns")
        .length,
      columns_modified: statements.filter((s) => s.phase === "modify_columns")
        .length,
      indexes_added: statements.filter((s) => s.phase === "add_indexes").length,
      indexes_dropped: statements.filter((s) => s.phase === "drop_indexes")
        .length,
      fks_added: statements.filter((s) => s.phase === "add_fks").length,
      fks_dropped: statements.filter((s) => s.phase === "drop_fks").length,
      total_statements: statements.length,
      include_drops: includeDrops === true,
      include_destructive_changes: includeDestructive === true,
    };

    const phaseLabels: Record<Phase, string> = {
      drop_fks: "Phase 1: Drop foreign keys",
      drop_indexes: "Phase 2: Drop indexes",
      drop_columns: "Phase 3: Drop columns",
      modify_columns: "Phase 4: Modify columns",
      add_columns: "Phase 5: Add columns",
      add_indexes: "Phase 6: Add indexes",
      add_fks: "Phase 7: Add foreign keys",
      drop_tables: "Phase 8: Drop tables",
      add_tables: "Phase 9: Create new tables",
    };

    const phasesInOrder: Phase[] = [
      "drop_fks",
      "drop_indexes",
      "drop_columns",
      "modify_columns",
      "add_columns",
      "add_indexes",
      "add_fks",
      "drop_tables",
      "add_tables",
    ];

    const sections: string[] = [
      banner,
      "",
      `-- Generated by generate_migration`,
      `-- Source: ${sourceConnection}:${src.db}`,
      `-- Target: ${targetConnection}:${tgt.db}`,
      `-- include_drops:                ${includeDrops === true}`,
      `-- include_destructive_changes:  ${includeDestructive === true}`,
      `-- Total statements: ${statements.length}`,
    ];

    if (
      !includeDrops &&
      (diff.tables.onlyInTarget.length > 0 ||
        diff.details.some(
          (d) =>
            (d.columns?.onlyInTarget.length ?? 0) > 0 ||
            (d.indexes?.onlyInTarget.length ?? 0) > 0 ||
            (d.foreignKeys?.onlyInTarget.length ?? 0) > 0,
        ))
    ) {
      sections.push(
        "-- NOTE: include_drops=false (default). Destructive DROP statements were SKIPPED.",
      );
      sections.push(
        "--       Re-run with include_drops=true to see DROP TABLE/COLUMN/INDEX/FK SQL.",
      );
    }
    if (
      !includeDestructive &&
      diff.details.some(
        (d) =>
          (d.columns?.modified.length ?? 0) > 0 ||
          (d.indexes?.modified.length ?? 0) > 0 ||
          (d.foreignKeys?.modified.length ?? 0) > 0,
      )
    ) {
      sections.push(
        "-- NOTE: include_destructive_changes=false (default). MODIFY COLUMN / re-index / re-FK SQL was SKIPPED.",
      );
      sections.push(
        "--       Re-run with include_destructive_changes=true to see those statements.",
      );
    }
    sections.push("");

    for (const phase of phasesInOrder) {
      const phaseStmts = statements.filter((s) => s.phase === phase);
      if (phaseStmts.length === 0) continue;
      sections.push(`-- ── ${phaseLabels[phase]} ──────────────────────`);
      for (const s of phaseStmts) {
        if (s.warnings.length > 0) {
          for (const w of s.warnings) sections.push(`-- WARNING: ${w}`);
        }
        sections.push(s.sql);
        sections.push("");
      }
    }

    if (statements.length === 0) {
      sections.push("-- No migration statements generated.");
      sections.push("-- Schemas are in sync (within the chosen flags).");
    }

    return toolOk(sections.join("\n"), {
      summary,
      statements,
    } as unknown as Record<string, unknown>);
  },
);

// ── registration ───────────────────────────────────────────────────

export function registerMigrationTools(server: McpServer) {
  server.registerTool(
    "generate_migration",
    {
      title: "Generate advisory ALTER/CREATE/DROP SQL",
      description:
        "Diff two schemas (source = desired state, target = the DB to modify) " +
        "and EMIT — never execute — the SQL statements that would bring target " +
        "in line with source. Output is ordered into phases (drop FKs → drop " +
        "indexes → drop columns → modify columns → add columns → add indexes → " +
        "add FKs → drop tables → create tables) for safe sequential application. " +
        "Destructive statements (DROP/MODIFY) are opt-in via flags. Every output " +
        "is preceded by an explicit `DO NOT EXECUTE BLINDLY` banner. V1 covers " +
        "tables, columns, indexes, and FKs — views/routines/triggers/events are " +
        "not generated; review compare_schemas for those.",
      inputSchema: {
        sourceConnection: z
          .string()
          .describe(
            "Connection holding the *desired* schema (e.g. staging, canonical).",
          ),
        sourceDatabase: z
          .string()
          .optional()
          .describe(
            "Source database name (uses the connection's active db if omitted).",
          ),
        targetConnection: z
          .string()
          .describe(
            "Connection holding the DB that would be MODIFIED by applying the generated SQL (e.g. prod).",
          ),
        targetDatabase: z
          .string()
          .optional()
          .describe(
            "Target database name (uses the connection's active db if omitted).",
          ),
        tables: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict comparison to these table names. Default: all tables.",
          ),
        include_drops: z
          .boolean()
          .optional()
          .describe(
            "Emit DROP TABLE / DROP COLUMN / DROP INDEX / DROP FOREIGN KEY " +
              "statements for objects in target but missing from source. Default false " +
              "— without this, the migration is purely additive. Destructive operations " +
              "always get explicit warning comments before the SQL.",
          ),
        include_destructive_changes: z
          .boolean()
          .optional()
          .describe(
            "Emit MODIFY COLUMN and re-create-index / re-create-FK statements for " +
              "objects that exist in both source and target but differ. Default false. " +
              "Type narrowing (VARCHAR(255)→VARCHAR(64), INT→SMALLINT) can silently " +
              "truncate data — every modify statement gets a warning comment.",
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGenerateMigration,
  );
}

import type {
  BaseDiff,
  ColumnDiff,
  IndexDiff,
  FKDiff,
  ViewDiff,
  RoutineDiff,
  TriggerDiff,
  EventDiff,
} from "../../types/db.js";
import { diffHasContent } from "./normalize.js";
import type { Scope } from "./scope.js";

/**
 * Markdown rendering for compare_schemas. Pure: takes a fully-built
 * RenderInput and returns a string. No I/O.
 *
 * RenderInput is the public shape the orchestrator hands us. Keep it
 * stable — it also doubles as the structuredContent in the tool's
 * response so MCP clients with rich rendering can consume it directly.
 */

export interface RenderInput {
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

export function renderMarkdown(r: RenderInput, summaryOnly: boolean): string {
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
    out.push(
      "_Per-table details suppressed (summaryOnly=true). See `structuredContent` for the full diff._",
    );
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
      if (d.columns)
        renderSubDiff(out, "Columns", d.columns, (c) => `\`${c.name}\` ${c.type}`);
      if (d.indexes)
        renderSubDiff(
          out,
          "Indexes",
          d.indexes,
          (i) =>
            `\`${i.name}\` (${i.columns.join(",")})${i.unique ? " UNIQUE" : ""}${i.visible ? "" : " INVISIBLE"}`,
        );
      if (d.foreignKeys)
        renderSubDiff(
          out,
          "Foreign keys",
          d.foreignKeys,
          (f) =>
            `\`${f.name}\` (${f.columns.join(",")}) → ${f.referencedTable}(${f.referencedColumns.join(",")})`,
        );
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

function pushTriad(
  out: string[],
  label: string,
  added: number,
  removed: number,
  modified: number,
): void {
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
  for (const m of diff.modified)
    out.push(`- modified \`${m.name}\`: ${m.diffs.join("; ")}`);
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
  for (const m of diff.modified)
    out.push(`- modified ${fmt(m.source)}: ${m.diffs.join("; ")}`);
}

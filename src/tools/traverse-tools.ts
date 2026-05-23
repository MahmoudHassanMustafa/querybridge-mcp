/**
 * `traverse_fk` — follow foreign keys outward from a seed row.
 *
 * The common debugging workflow: "show me this order, then the user
 * who placed it, then their other orders, then the items on each."
 * Without this tool, an agent chains `execute_query` calls — each one
 * needing custom JOIN SQL. `traverse_fk` does breadth-first FK
 * navigation with cycle detection so the agent gets back a connected
 * graph in one tool call.
 *
 * V1 design choices:
 *
 *   - **Single-column primary keys only.** Composite-PK tables refuse
 *     with COMPOSITE_PK_NOT_SUPPORTED. Most schemas have single-col
 *     PKs; supporting composite would force the agent to encode a
 *     value object per row, which is awkward at the call site.
 *
 *   - **Bounded traversal.** Three caps:
 *       * `depth` (default 2, max 3) — how many hops out.
 *       * `max_rows_per_step` (default 10, max 50) — fan-out cap when
 *         expanding INTO a child table.
 *       * Hard total-node cap (200) — stops the whole traversal if the
 *         graph genuinely blows up regardless of the per-step cap.
 *
 *   - **Read-only.** Every query is a SELECT against the live data
 *     plus information_schema for FK / PK metadata.
 *
 *   - **Direction control.** `direction: "children" | "parents" | "both"`
 *     (default "both"). "Children" = tables that reference this row's
 *     PK; "parents" = tables this row references via its own FKs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWithTimeout } from "../connection.js";
import { resolveDb } from "../db/resolve.js";
import {
  getForeignKeys,
  getIncomingForeignKeys,
  getPrimaryKeyColumns,
  type ForeignKeyRow,
} from "../db/introspection.js";
import { qualifiedTable, escapeId } from "../sql/identifiers.js";
import {
  toolError,
  toolHandler,
  toolOk,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../tool-runtime.js";

// ── caps ────────────────────────────────────────────────────────────

/** Whichever happens first stops the BFS: depth, per-step rows, or total nodes. */
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 3;
const DEFAULT_MAX_ROWS_PER_STEP = 10;
const MAX_ROWS_PER_STEP_CAP = 50;
/**
 * Hard total-node cap. A single seed row in a richly-connected
 * schema can fan out fast — even with reasonable per-step caps, a
 * shipping-app schema can produce thousands of nodes in 2-3 hops.
 * 200 nodes is plenty for any debugging-style use case; if the cap
 * trips, the response calls it out so the agent knows to narrow.
 */
const TOTAL_NODE_CAP = 200;

// ── traversal types ───────────────────────────────────────────────

type Direction = "children" | "parents" | "both";

interface RowNode {
  /** `${table}#${pk_value}` — unique identifier in the traversal graph. */
  id: string;
  table: string;
  /** Single-key shape: `{ <pk_col_name>: <pk_value> }`. V1 only supports single-col PKs. */
  primary_key: Record<string, unknown>;
  /** Full row from the live data. */
  columns: Record<string, unknown>;
}

interface FkEdge {
  from: string;
  to: string;
  /** Human-readable: `child.col → parent.col`. */
  via: string;
  direction: "parent" | "child";
}

interface Truncation {
  /** The child table whose fan-out was clipped. */
  table: string;
  /** Always "max_rows_per_step" in V1 — the only per-step truncation. */
  reason: "max_rows_per_step";
  limit: number;
}

interface TraverseResult {
  starting: { table: string; primary_key: Record<string, unknown> };
  nodes: RowNode[];
  edges: FkEdge[];
  depth_reached: number;
  truncations: Truncation[];
  total_node_cap_hit: boolean;
}

// ── helpers ────────────────────────────────────────────────────────

/**
 * `${table}#${stringified pk value}` — the cycle-detection key.
 * JSON.stringify gives a stable representation across numeric and
 * string PKs, with quote-correct escaping for the rare PK value
 * containing `#`.
 */
function nodeId(table: string, pkValue: unknown): string {
  return `${table}#${JSON.stringify(pkValue)}`;
}

/** SELECT * FROM <db>.<table> WHERE <pk> = ? LIMIT 1 — fetch one row by PK. */
async function fetchByPrimaryKey(
  connection: string,
  db: string,
  table: string,
  pkCol: string,
  pkValue: unknown,
): Promise<Record<string, unknown> | null> {
  // sample_data uses the same pattern — opt out of the
  // concrete-row-type lint rule because traverse fetches arbitrary
  // user-table rows by design.
  // eslint-disable-next-line local/no-record-unknown-query-result
  const rows = await queryWithTimeout<Array<Record<string, unknown>>>(
    connection,
    `SELECT * FROM ${qualifiedTable(db, table)} WHERE ${escapeId(pkCol)} = ? LIMIT 1`,
    [pkValue],
  );
  return rows[0] ?? null;
}

/** SELECT * FROM <db>.<table> WHERE <fk_col> = ? LIMIT <max> — fan-out into children. */
async function fetchByForeignKey(
  connection: string,
  db: string,
  table: string,
  fkCol: string,
  fkValue: unknown,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  // Same row-shape opt-out reason as fetchByPrimaryKey.
  // eslint-disable-next-line local/no-record-unknown-query-result
  return queryWithTimeout<Array<Record<string, unknown>>>(
    connection,
    `SELECT * FROM ${qualifiedTable(db, table)} WHERE ${escapeId(fkCol)} = ? LIMIT ?`,
    [fkValue, limit],
  );
}

/**
 * Cache of (table → PK column name) lookups within a single traversal.
 * BFS revisits parent tables often; one info_schema query per table is
 * enough.
 */
type PkCache = Map<string, string | null>;

async function pkColFor(
  cache: PkCache,
  connection: string,
  db: string,
  table: string,
): Promise<string | null> {
  const cached = cache.get(table);
  if (cached !== undefined) return cached;
  const cols = await getPrimaryKeyColumns(connection, db, table);
  // V1: refuse composite PKs. Single-col only.
  const result = cols.length === 1 ? (cols[0] ?? null) : null;
  cache.set(table, result);
  return result;
}

// ── handler ────────────────────────────────────────────────────────

interface TraverseFkArgs {
  connection: string;
  database?: string | undefined;
  table: string;
  primary_key_value: string | number;
  direction?: Direction | undefined;
  depth?: number | undefined;
  max_rows_per_step?: number | undefined;
  [key: string]: unknown;
}

export const handleTraverseFk = toolHandler<TraverseFkArgs>(
  "traverse_fk",
  async ({
    connection,
    database,
    table,
    primary_key_value: pkValue,
    direction,
    depth,
    max_rows_per_step,
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const dir = direction ?? "both";
    const maxDepth = Math.min(depth ?? DEFAULT_DEPTH, MAX_DEPTH);
    const stepCap = Math.min(
      max_rows_per_step ?? DEFAULT_MAX_ROWS_PER_STEP,
      MAX_ROWS_PER_STEP_CAP,
    );

    const pkCache: PkCache = new Map();
    const startingPk = await pkColFor(pkCache, connection, r.db, table);
    if (startingPk === null) {
      return toolError(
        `Table ${table} has no primary key, or a composite primary key — not supported by traverse_fk V1.`,
        {
          code: "COMPOSITE_PK_NOT_SUPPORTED",
          hint: "V1 only follows single-column primary keys. Use execute_query with a custom JOIN for composite-PK tables.",
          suggestions: [
            {
              tool: "describe_table",
              reason: "inspect the actual primary key structure",
              args: { connection, database: r.db, table },
            },
          ],
        },
      );
    }

    const seedRow = await fetchByPrimaryKey(
      connection,
      r.db,
      table,
      startingPk,
      pkValue,
    );
    if (!seedRow) {
      return toolError(
        `No row in ${table} with ${startingPk} = ${JSON.stringify(pkValue)}.`,
        {
          code: "SEED_ROW_NOT_FOUND",
          hint: "Verify the primary key value, or that the row exists.",
          suggestions: [
            {
              tool: "sample_data",
              reason: "preview rows from this table to find a real PK value",
              args: { connection, database: r.db, table },
            },
          ],
        },
      );
    }

    const seedNode: RowNode = {
      id: nodeId(table, pkValue),
      table,
      primary_key: { [startingPk]: pkValue },
      columns: seedRow,
    };

    const visited = new Set<string>([seedNode.id]);
    const nodes: RowNode[] = [seedNode];
    const edges: FkEdge[] = [];
    const truncations: Truncation[] = [];
    let totalNodeCapHit = false;
    let maxDepthReached = 0;

    interface QueueEntry {
      node: RowNode;
      depth: number;
    }
    const queue: QueueEntry[] = [{ node: seedNode, depth: 0 }];

    while (queue.length > 0) {
      const head = queue.shift();
      if (!head) break; // unreachable — guarded by queue.length > 0
      const { node: current, depth: currentDepth } = head;
      maxDepthReached = Math.max(maxDepthReached, currentDepth);
      if (currentDepth >= maxDepth) continue;
      if (nodes.length >= TOTAL_NODE_CAP) {
        totalNodeCapHit = true;
        break;
      }

      // FK metadata for this table — one pair of queries, both small.
      const [outgoing, incoming] = await Promise.all([
        dir !== "children"
          ? getForeignKeys(connection, r.db, [current.table])
          : Promise.resolve<ForeignKeyRow[]>([]),
        dir !== "parents"
          ? getIncomingForeignKeys(connection, r.db, [current.table])
          : Promise.resolve<ForeignKeyRow[]>([]),
      ]);

      // ── PARENT direction: this row → its references ───────────────
      for (const fk of outgoing) {
        const fkValueOnRow = current.columns[fk.COLUMN_NAME];
        if (fkValueOnRow == null) continue; // FK column is NULL
        const parentPk = await pkColFor(
          pkCache,
          connection,
          r.db,
          fk.REFERENCED_TABLE_NAME,
        );
        if (parentPk === null) continue; // parent has composite PK — skip
        const parentRow = await fetchByPrimaryKey(
          connection,
          r.db,
          fk.REFERENCED_TABLE_NAME,
          parentPk,
          fkValueOnRow,
        );
        if (!parentRow) continue;
        const parentId = nodeId(fk.REFERENCED_TABLE_NAME, fkValueOnRow);
        const newNode = !visited.has(parentId);
        if (newNode) {
          visited.add(parentId);
          const newRowNode: RowNode = {
            id: parentId,
            table: fk.REFERENCED_TABLE_NAME,
            primary_key: { [parentPk]: fkValueOnRow },
            columns: parentRow,
          };
          nodes.push(newRowNode);
          queue.push({ node: newRowNode, depth: currentDepth + 1 });
          if (nodes.length >= TOTAL_NODE_CAP) {
            totalNodeCapHit = true;
            break;
          }
        }
        edges.push({
          from: current.id,
          to: parentId,
          via: `${current.table}.${fk.COLUMN_NAME} → ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`,
          direction: "parent",
        });
      }
      if (totalNodeCapHit) break;

      // ── CHILD direction: this row's PK → tables that reference it ───
      for (const fk of incoming) {
        const referencedValue = current.columns[fk.REFERENCED_COLUMN_NAME];
        if (referencedValue == null) continue; // the referenced column is NULL on the seed (rare for a PK)
        const childRows = await fetchByForeignKey(
          connection,
          r.db,
          fk.TABLE_NAME,
          fk.COLUMN_NAME,
          referencedValue,
          stepCap,
        );
        if (childRows.length === stepCap) {
          // Could have more — flag truncation so the agent knows to
          // narrow if it needs the rest.
          truncations.push({
            table: fk.TABLE_NAME,
            reason: "max_rows_per_step",
            limit: stepCap,
          });
        }
        const childPk = await pkColFor(
          pkCache,
          connection,
          r.db,
          fk.TABLE_NAME,
        );
        if (childPk === null) continue; // child has composite PK — can't id rows uniquely
        for (const childRow of childRows) {
          const childPkValue = childRow[childPk];
          if (childPkValue == null) continue;
          const childId = nodeId(fk.TABLE_NAME, childPkValue);
          if (!visited.has(childId)) {
            visited.add(childId);
            const newRowNode: RowNode = {
              id: childId,
              table: fk.TABLE_NAME,
              primary_key: { [childPk]: childPkValue },
              columns: childRow,
            };
            nodes.push(newRowNode);
            queue.push({ node: newRowNode, depth: currentDepth + 1 });
            if (nodes.length >= TOTAL_NODE_CAP) {
              totalNodeCapHit = true;
              break;
            }
          }
          edges.push({
            from: current.id,
            to: childId,
            via: `${fk.TABLE_NAME}.${fk.COLUMN_NAME} → ${current.table}.${fk.REFERENCED_COLUMN_NAME}`,
            direction: "child",
          });
        }
        if (totalNodeCapHit) break;
      }
      if (totalNodeCapHit) break;
    }

    const result: TraverseResult = {
      starting: { table, primary_key: { [startingPk]: pkValue } },
      nodes,
      edges,
      depth_reached: maxDepthReached,
      truncations,
      total_node_cap_hit: totalNodeCapHit,
    };

    // Render: tree-ish summary keyed off the seed, with each edge
    // rendered as `via` annotation. Full node columns live in
    // structuredContent only — the text body would otherwise dominate.
    const lines: string[] = [
      `Traversal from ${table}.${startingPk} = ${JSON.stringify(pkValue)}`,
      "",
      `${nodes.length} unique row(s) across ${new Set(nodes.map((n) => n.table)).size} table(s); ${edges.length} edge(s); depth reached: ${maxDepthReached}`,
    ];
    if (truncations.length > 0) {
      lines.push("");
      lines.push("Truncations:");
      for (const t of truncations) {
        lines.push(`  • ${t.table}: capped at ${t.limit} rows per step`);
      }
    }
    if (totalNodeCapHit) {
      lines.push("");
      lines.push(
        `⚠ Total node cap (${TOTAL_NODE_CAP}) hit — graph truncated. Re-run with a lower depth or max_rows_per_step.`,
      );
    }
    lines.push("");
    lines.push("Edges:");
    for (const e of edges) {
      lines.push(`  ${e.from}  ──(${e.direction})──>  ${e.to}    via ${e.via}`);
    }

    return toolOk(
      lines.join("\n"),
      result as unknown as Record<string, unknown>,
    );
  },
);

// ── registration ───────────────────────────────────────────────────

export function registerTraverseTools(server: McpServer) {
  server.registerTool(
    "traverse_fk",
    {
      title: "Follow foreign keys outward from a row",
      description:
        "Breadth-first navigation of FK relationships from a seed row. " +
        "Given a starting (table, primary_key_value), walks outward — to " +
        "tables this row references (parents) and tables that reference it " +
        "(children) — collecting a connected graph of related rows. " +
        "Cycle-detected; bounded by depth (max 3), per-step row cap " +
        "(max 50), and a total node cap (200). V1 only supports single-column primary keys.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z
          .string()
          .optional()
          .describe("Database (uses the connection's active db if omitted)."),
        table: z.string().describe("Starting table."),
        primary_key_value: z
          .union([z.string(), z.number()])
          .describe(
            "Primary key value of the seed row. V1 supports single-column PKs only.",
          ),
        direction: z
          .enum(["children", "parents", "both"])
          .optional()
          .describe(
            "Which way to traverse: `children` (tables that reference this row), " +
              "`parents` (tables this row references), or `both` (default).",
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(MAX_DEPTH)
          .optional()
          .describe(
            `How many FK hops out. Default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}.`,
          ),
        max_rows_per_step: z
          .number()
          .int()
          .min(1)
          .max(MAX_ROWS_PER_STEP_CAP)
          .optional()
          .describe(
            `Per-table fan-out cap when expanding into children. Default ${DEFAULT_MAX_ROWS_PER_STEP}, max ${MAX_ROWS_PER_STEP_CAP}.`,
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleTraverseFk,
  );
}

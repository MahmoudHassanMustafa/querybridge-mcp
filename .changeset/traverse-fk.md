---
"querybridge-mcp": minor
---

**New tool: `traverse_fk`.** Breadth-first FK navigation from a seed row.

The workflow: an agent has a row in hand and wants the connected graph around it — _"show me this order, the user who placed it, their other orders, the items on each."_ Without `traverse_fk`, that's a chain of `execute_query` calls each requiring custom JOIN SQL the agent has to write from scratch. With it: one tool call, a connected `{ nodes, edges }` graph back.

**Inputs:**

- `connection` (required)
- `database` (optional)
- `table` (required) — starting table
- `primary_key_value` (required, string or number) — V1 supports single-column primary keys only
- `direction` (optional, default `both`) — `"children"` follows tables that reference this row, `"parents"` follows tables this row references
- `depth` (optional, default 2, max 3) — how many FK hops out
- `max_rows_per_step` (optional, default 10, max 50) — per-table fan-out cap when expanding into children

**Output (`structuredContent`):**

```ts
{
  starting: { table, primary_key: { <col>: <value> } },
  nodes: Array<{ id, table, primary_key, columns }>,
  edges: Array<{ from, to, via, direction: "parent" | "child" }>,
  depth_reached: number,
  truncations: Array<{ table, reason: "max_rows_per_step", limit }>,
  total_node_cap_hit: boolean,
}
```

**Caps that keep things bounded** in a richly-connected schema:

| Cap                                      | Default | Max     |
| ---------------------------------------- | ------- | ------- |
| `depth`                                  | 2       | 3       |
| `max_rows_per_step`                      | 10      | 50      |
| Total nodes across all levels (hard cap) | —       | **200** |

Truncations are surfaced explicitly in the response so the agent knows whether to narrow or accept the graph.

**Cycle detection** uses a Set keyed by `${table}#${JSON.stringify(pk_value)}` — a row reached via multiple paths becomes one node with multiple edges.

**Error paths:**

- `COMPOSITE_PK_NOT_SUPPORTED` (with a `describe_table` suggestion pre-filled) — V1 only walks single-column PKs.
- `SEED_ROW_NOT_FOUND` (with a `sample_data` suggestion pre-filled) — the seed PK doesn't match any row.

**Tests:** 6 new unit tests (pre-flight errors, BFS single-hop in both directions, text rendering, cycle detection deduping a self-referencing path) + 4 new integration tests against MySQL 8.4 with the seeded `users`/`orders` schema (parent walk, child walk with multiple children, depth=2 both-direction cycle, seed-not-found error).

**New introspection helpers:**

- `getIncomingForeignKeys(connection, db, tables[])` — reverse-direction FK lookup (find every FK whose `REFERENCED_TABLE_NAME` matches), used by the child-traversal step.
- `getPrimaryKeyColumns(connection, db, table)` — PK column names for any table, used by the cycle-detection key and to refuse composite PKs.

Final PR of the originally-scoped three-PR series (PR A: profiling, PR B: diagnostics, PR C: this).

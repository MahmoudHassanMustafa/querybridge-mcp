---
"querybridge-mcp": minor
---

**`tables: string[]` filter on `describe_table`, `get_ddl`, `get_foreign_keys`, `get_indexes`.** Same pattern just shipped on `get_table_stats` — adds the "some" mode an agent reaches for constantly. Backward-compatible: existing `table: "..."` callers keep working unchanged.

### What changes per tool

**`describe_table` / `get_ddl`** — dual-shape, decided by which arg is set:

- `table: "users"` → flat single-table response (legacy shape: `{ database, table, columns, indexes, createStatement }`).
- `tables: ["users", "orders"]` → array response (`{ database, results: [{ table, isView, columns, indexes, createStatement }, ...] }`).
- Mixing both forms merges and deduplicates the target set; the array shape kicks in if `tables` is set.
- When neither is provided, a clear `DESCRIBE_TABLE_NO_TARGET` / `GET_DDL_NO_TARGET` error with a `list_tables` suggestion.
- Views in a multi-table batch are flagged with `isView: true` rather than failing the whole call — the agent sees mixed input mistakes inline.

**`get_foreign_keys` / `get_indexes`** — same flat shape in all modes (these tools already mixed across tables in the all-mode), just adds `tables: []` as a filter alongside the existing `table: string` and "omit for all" modes. Empty-state phrasing adapts: _"No foreign keys on orders"_ → _"No foreign keys on 2 tables"_ when filtering a batch.

### Why this matters

The agent workflow _"show me the schema of users, orders, and events"_ used to be N calls. Now it's one. Same story for _"get the DDL for these five tables"_ — the bulk path is one round-trip + one Promise.all over the per-table SHOW CREATE / DESCRIBE calls.

### Under the hood

- `getForeignKeys` and `getIndexStats` introspection helpers widened from `table?: string` to `tables?: readonly string[]`, emitting `TABLE_NAME IN (?, ?, ...)` for the filter.
- `describe_table` now calls a shared `describeOneTable` helper per target, in parallel via `Promise.all`. The view-detection short-circuit is preserved (skip `SHOW INDEX` on detected views) so the extra-query cost only applies to real tables.

### Tests

- **8 new unit tests** — `tables: []` filter shapes on `get_foreign_keys` (single-elem, multi-elem, dedup-merge), `describe_table` (array response, view-flagging inside batches, no-target error), `get_ddl` (array response + headers, no-target error).
- **Updated 2 introspection tests** to match the widened helper signatures (now take `readonly string[] | undefined`).

Tool descriptions and titles updated to surface the modes prominently (_"Describe table (one or many)"_, _"Get foreign keys (one, some, or all tables)"_) so an agent scanning the tool list sees the bulk capability without reading param descriptions.

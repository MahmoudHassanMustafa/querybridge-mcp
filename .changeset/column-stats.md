---
"querybridge-mcp": minor
---

**New tool: `column_stats`.** Per-column profiling for a table — null %, distinct count, min/max/avg, and (optionally) the top-N most common values per column.

Designed for the workflow agents constantly hit: _"what does this column actually contain?"_ Without `column_stats`, an agent has to chain 4–6 `execute_query` calls per column. This tool collapses the whole profile into **one combined-aggregation query** (single table scan), with an optional per-column top-N follow-up.

**Inputs:**

- `connection` (string, required)
- `table` (string, required)
- `database` (string, optional) — uses the connection's active db if omitted
- `columns` (string[], optional) — restrict to specific columns; order preserved from the table definition
- `top_n` (number, optional, 0–20) — if > 0, include the N most common values per column (one extra query per column)

**Type-aware metric selection:**

- **Numeric** (`int`, `decimal`, `float`, etc.): MIN, MAX, AVG
- **Temporal / short string** (`datetime`, `varchar`, `char`, `enum`, `set`): MIN, MAX (lexicographic for strings); no AVG
- **Large opaque** (`text`, `blob`, `json`, geometry types): COUNT and COUNT DISTINCT only — MIN/MAX/AVG would risk pulling huge values into the response
- Skipped metrics get a `notes` array explaining why ("avg skipped — type `text` is not numeric")

**Structured output:** `{ database, table, total_rows, columns: [{ name, type, count_non_null, null_pct, count_distinct, distinct_pct, min, max, avg, top_values?, notes? }] }` — fully agent-actionable.

**Error path:** `TABLE_NOT_FOUND` (with `list_tables` + `search_columns` suggestions, connection/database pre-filled), `COLUMNS_NOT_FOUND` (with a `describe_table` suggestion).

**Tests:** 8 new unit tests (metadata gate, aggregation-SQL shape verification per type, response-shape assertions on null_pct / distinct_pct / notes / call counts) + 5 new integration tests against MySQL 8.4 with a seeded distribution-known fixture (110 rows: 60 active / 30 pending / 10 banned status, age 0–99 with 10 NULLs, mixed BLOB nullability).

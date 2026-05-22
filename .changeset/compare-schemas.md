---
"querybridge-mcp": minor
---

**New tool: `compare_schemas`.** Diff two databases — same connection or cross-connection (staging vs prod is the canonical case). The richest single-tool addition this release.

**Scopes** (all on by default; pass a subset for cheaper runs on huge schemas):

| Scope | What it covers |
|---|---|
| `tables` | Existence — present in source / target / both |
| `tableAttributes` | Engine (InnoDB vs MyISAM), default charset, collation, comment, row format, **partitioning** (method, expression, partition count) |
| `columns` | Type, nullable, default, key, comment, EXTRA, generated-column expression |
| `indexes` | Columns, uniqueness, type, **MySQL 8 invisible indexes**, prefix lengths, functional-index expressions |
| `foreignKeys` | Columns, referenced table/columns (composite-FK aware), ON UPDATE/DELETE |
| `views` | Definition (whitespace-normalized), updatability, security type, check option |
| `routines` | Procedure/function, parameter signature, body, security, deterministic, data access |
| `triggers` | Table, event, timing, orientation, body |
| `events` | Type, interval, status, body |

**Robustness:**

- **Cross-version semantic equivalence.** `int(11)` → `int` is normalized for MySQL 5.7 vs 8.0+ diffs; `tinyint(1)` is preserved as the boolean idiom. SQL bodies (views/routines/triggers/events) are whitespace-normalized before comparison.
- **Cancellation.** Honors `RequestHandlerExtra.signal` between scopes — same pattern as `execute_query` / `explain_query`.
- **`summaryOnly` flag** suppresses per-table details in the markdown output for huge diffs that would blow past the context budget. Structured content is unaffected.
- **IN-list chunking** for schemas with thousands of tables — keeps queries below `max_allowed_packet`.
- **MCP `notifications/progress`** — first tool to use them. Clients that pass a `progressToken` see one tick per scope completed.

**Output:** structured JSON (`structuredContent`) for clients that consume it, plus a markdown summary in `content` for humans. In-sync databases get a one-line confirmation.

**Intentional v1 exclusions** (and why):

- No migration SQL generation — too easy to ship a destructive `DROP COLUMN` that loses data. Diff is advisory; operators craft migrations themselves.
- No table-rename heuristic detection — false positives easier to ship than to undo.
- View/routine/trigger/event **bodies are diffed but not rendered inline** in the markdown; the structured content has the full text. Keeps output sane on huge bodies.

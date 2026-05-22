---
"querybridge-mcp": minor
---

**New tool: `compare_schema_file`.** Diff a checked-in `.sql` schema file against a live database — the CI workflow that catches a developer adding a column in a migration but forgetting to update the canonical schema-as-source-of-truth file.

**How it works:** loads the file into a temp database (`_qbmcp_check_<random>`) on a writable scratch connection, delegates to the same comparison engine `compare_schemas` uses, and drops the temp DB on the way out. MySQL parses the DDL natively — no new SQL-parser dependency.

**Inputs:**

- `live_connection` (string, required)
- `live_database` (string, optional) — uses the connection's active db when omitted
- `scratch_connection` (string, required) — must be configured with `readonly: false`
- `schema_path` (string, required) — relative paths resolve against the server's cwd
- `tables`, `scope`, `summaryOnly` — same semantics as `compare_schemas`

**Safety:**

- Refuses if `scratch_connection` is read-only (clear pre-flight error with a `list_connections` suggestion).
- Refuses `schema_path` under `/proc`, `/dev`, `/sys`, `/boot`; refuses null bytes; refuses directories; refuses files > 16 MiB.
- Temp DB has a `_qbmcp_check_` prefix + 12-hex-char suffix so concurrent CI runs don't collide. Always dropped in `finally` — verified by the integration suite.
- Per-statement error reporting: if the load fails on statement N, the response says "statement N of M" with a head of the offending SQL so an operator can find the line at fault without re-reading the file.

**V1 limitations** (documented in the tool's source comments):

- No `DELIMITER` support — stored routines / triggers with `;` inside their bodies won't split cleanly. Workaround: drop those from the file or load them through a different tool.
- No data import — only DDL. INSERTs in the file aren't needed for schema comparison.

**Refactor:** the comparison engine moved out of `compare/index.ts` into `compare/engine.ts` so both `compare_schemas` (two live DBs) and `compare_schema_file` (file vs live DB) call into it. No behaviour change to `compare_schemas`.

**New shared primitive:** `src/sql/split.ts` (14 unit tests) — a comment- and quote-aware SQL statement splitter. Public-API stable; available for any future tool that needs to apply a multi-statement script through the pool's `multipleStatements: false` connections.

**Tests:** 10 new unit tests (splitter cadence/quoting/comments, path validation, pre-load gates, scratch-readonly refusal) + 5 new integration tests against MySQL 8.4 (matching schema → inSync, extra table → drift detected, file-path source label, broken-DDL error with statement index, temp DB cleanup verified by SHOW DATABASES delta).

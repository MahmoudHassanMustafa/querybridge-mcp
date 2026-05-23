---
"querybridge-mcp": minor
---

**Diagnostics pack — 6 operator-grade observability tools.** Server snapshot, system-variable and runtime-counter inspection, lock-wait surfacing, raw InnoDB status with deadlock extraction, and a `performance_schema`-backed slow-query digest summary.

### Tools

| Tool                 | What                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`server_info`**    | One round-trip bird's-eye snapshot: version, hostname, uptime, thread counts (running / connected / max), key character set & collation, SQL mode, time zone, read-only flags. Sensible "n/a" rendering for variables the server doesn't expose (older MySQL forks).         |
| **`show_variables`** | `SHOW VARIABLES` with `pattern` (SQL LIKE) and `scope` (`GLOBAL` \| `SESSION`, default GLOBAL) filters.                                                                                                                                                                      |
| **`show_status`**    | Same shape for `SHOW STATUS` — runtime counters (`Threads_%`, `Bytes_sent`, `Slow_queries`, …).                                                                                                                                                                              |
| **`current_locks`**  | Joins `performance_schema.data_lock_waits` to `data_locks`, `threads`, and `events_statements_current` to surface every active blocker → blocked pair with the SQL each thread is running.                                                                                   |
| **`innodb_status`**  | `SHOW ENGINE INNODB STATUS` raw dump (wrapped in a fenced code block in the text body); also parses the `LATEST DETECTED DEADLOCK` section into a separate `latest_deadlock` field in `structuredContent` for easy programmatic access.                                      |
| **`slow_queries`**   | Top-N digests from `performance_schema.events_statements_summary_by_digest`. Sort by `total_time` (default — biggest aggregate offenders), `avg_time`, `max_time`, or `count`. Returns count, total/avg/max time in ms, and rows examined per digest. `limit` capped at 100. |

### Privileges

`current_locks` and `slow_queries` need `SELECT` on `performance_schema`. The integration suite explicitly grants it during fixture setup; in production this is the standard grant for any monitoring user. Without it, those two tools surface MySQL's `SELECT command denied` error verbatim through the standard `toolHandler` sanitization.

### Tests

- **18 new unit tests** — SQL shape verification per scope/keyword branch on `show_variables` / `show_status`, response-shape assertions on `server_info` (including the "every variable is null on old MySQL" case), `current_locks` empty-state and blocker-pair rendering, `innodb_status` deadlock extraction regex, `slow_queries` sort-by → ORDER BY mapping and 100-row LIMIT cap.
- **6 new integration tests** against MySQL 8.4 — real version + uptime via `server_info`, LIKE filter on `show_variables`, `Threads_%` counters from `show_status`, idle-server empty list from `current_locks`, real status dump from `innodb_status` (containing "BACKGROUND THREAD"), `slow_queries` shape assertion under `sort_by=count`.

**Total: 463 unit + 35 integration tests.** Lint clean (90 modules, 307 deps, 0 violations).

PR series note: this is the second of three PRs originally scoped (PR A: profiling, PR B: diagnostics, PR C: traverse_fk).

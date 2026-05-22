# querybridge-mcp

## 0.9.1

### Patch Changes

- 9e9425a: **Security: clear all `pnpm audit` advisories** by bumping transitive dependencies in the lockfile. No `package.json` ranges changed; no production code touched. Every bump stayed within the upstream constraint windows.

  | Dep                                                    | Before → After    | Cleared                                                                                     |
  | ------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------- |
  | `hono` (via `@modelcontextprotocol/sdk`)               | 4.12.12 → 4.12.22 | 5 advisories (cache-Vary, body-limit bypass, JSX/CSS injection, JWT NumericDate validation) |
  | `fast-uri` (via `@modelcontextprotocol/sdk > ajv`)     | 3.1.0 → 3.1.2     | 2 high (path traversal, host confusion)                                                     |
  | `express-rate-limit` (via `@modelcontextprotocol/sdk`) | 8.3.2 → 8.5.2     | (cascade)                                                                                   |
  | `ip-address` (via `express-rate-limit`)                | 10.1.0 → 10.2.0   | 1 moderate (XSS in `Address6` HTML-emitting methods)                                        |

  **Real-world impact:** low — the vulnerable code paths weren't reachable in querybridge-mcp's runtime:
  - We don't use the SDK's `hono` route; our HTTP transport speaks straight to Node's `http` via `StreamableHTTPServerTransport.handleRequest()`.
  - We don't mount the SDK's `express-rate-limit` middleware.
  - `fast-uri` is used by `ajv` for `$ref` URI parsing in Zod-schema validation at the tool boundary — narrow exposure but technically reachable on malformed input.

  Hygiene update; existing tests + lint + dep-cruiser all pass unchanged.

  **Also in this release: security docs maintenance.**
  - **`SECURITY.md` refreshed** — added a versioned "Supported Versions" table; expanded the Network Surface section to cover the HTTP transport's listening behavior and reverse-proxy / OAuth pattern (the pre-HTTP-transport text said the server "does not open network ports", which stopped being true at 0.7.0); added a Dependency Hygiene section documenting how `pnpm audit` fixes ship as patch releases.
  - **`compare_schema_file` scratch-user privilege guidance** — explicit recommendation to scope the scratch MySQL user to the `_qbmcp_check_*` namespace (the prefix the tool always uses for its temp DBs) rather than `*.*`. Example grant:

    ```sql
    GRANT CREATE, DROP, ALL PRIVILEGES ON `_qbmcp_check_%`.*
      TO '<scratch_user>'@'<host>';
    ```

    Bounds the blast radius if the scratch credentials ever leak — a hostile agent with that user can only touch databases matching the prefix, not the live database alongside it. Documented in `SECURITY.md`, the tool's source comment, and the README Safety section.

## 0.9.0

### Minor Changes

- 5801e7c: **New tool: `compare_schema_file`.** Diff a checked-in `.sql` schema file against a live database — the CI workflow that catches a developer adding a column in a migration but forgetting to update the canonical schema-as-source-of-truth file.

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

### Patch Changes

- f3ed48d: **Internal: tagged `sql\`\`` template helper.** New `src/sql/template.ts` exports `sql`, `id`, and `raw` for assembling parameterized SQL with explicit identifier escaping and explicit-unsafe integer interpolation.

  **Why:** three sites in the codebase need to inline a value MySQL doesn't accept `?` placeholders for — `KILL QUERY <id>`, `KILL CONNECTION <id>`, and `SHOW CREATE PROCEDURE/FUNCTION <db>.<name>`. Each previously used `// eslint-disable-next-line no-restricted-syntax` to silence the SQL-template lint rule. The new helper replaces those bypasses with `raw()` (runtime-checked finite integer) and `id()` (`escapeId`-wrapped identifier), so the unsafe-by-necessity intent is visible at the call site instead of being a silenced lint warning.

  **API:**

  \`\`\`ts
  import { sql, id, raw } from "./sql/template.js";

  await worker.query(sql\`KILL QUERY \${raw(connectionId)}\`);
  await worker.query(sql\`SHOW CREATE PROCEDURE \${id(db)}.\${id(name)}\`);
  await worker.query(sql\`SELECT \* FROM users WHERE id = \${userId}\`); // userId → ? param
  \`\`\`

  Returns `{ sql: string, values: unknown[] }`, directly compatible with mysql2's `query()` / `execute()` QueryOptions overload.

  **No public behaviour change.** All migrated sites send the exact same SQL bytes to MySQL — the helper just makes how those bytes are assembled type-safe and lint-clean. Verified by the existing KILL-QUERY integration test still passing against MySQL 8.4.

  **Tests:** 16 new unit tests for the helper (plain interpolation → parameter, `id()` identifier escaping, `raw()` integer guard, mixed slots in order, edge cases: null/undefined/NaN/Infinity/string-sneak-through).

## 0.8.0

### Minor Changes

- dfeb8e4: **LLM-friendly error responses.** Tool failures now carry structured `suggestions` — a list of `{ tool, reason, args? }` pointers an agent can act on programmatically — in addition to the existing human-readable `hint` text. Failed responses also include a stable `code` in `structuredContent` so agents branch on a fixed token instead of pattern-matching the message string.

  **What changes on the wire:** `toolError` responses gain a `structuredContent` field of shape `{ code?, suggestions? }` when there's something machine-actionable to deliver. The text body gains a "Try one of these tools next:" bullet list when suggestions exist; clients that don't render structured content still see the right next steps in plain text.

  **Where it helps:**
  - `ConnectionNotFound` → suggests `list_connections`.
  - `DatabaseNotResolved` → suggests `list_databases` and `use_database`.
  - `ReadOnlyViolation` → suggests `list_connections` (to find a writable connection).
  - `MalformedExplainOutput` → suggests `explain_query` with `format: "TRADITIONAL"` pre-filled in `args`.
  - `use_database` with a non-existent database → suggests `list_databases` with the failing `connection` pre-filled.
  - `describe_table` when the object is actually a view → suggests `describe_view` and `get_view_ddl` with `connection`, `database`, and `view` all pre-filled.
  - `streaming_query` rejecting write SQL → suggests `execute_query` with the original `connection` and `query` pre-filled.

  **Pre-filling matters:** when the failing call already knew the connection/database/table, the suggestion carries those values forward. The agent doesn't re-derive context from the failure message — one less round trip and one less opportunity to fumble the args.

  **API.** `toolError("msg", "hint")` keeps working unchanged (legacy overload). The new form is `toolError("msg", { hint?, code?, suggestions? })`. `QueryBridgeError` subclasses can declare a static `suggestions` array; `toolHandler` forwards it onto the response.

  **Tests:** 12 new unit tests — toolError shape (legacy + structured), QueryBridgeError forwarding via toolHandler (`ConnectionNotFound`, `ReadOnlyViolation`, `DatabaseNotResolved`, `MalformedExplainOutput`), and real tools (`use_database`, `describe_table`) emitting suggestions with pre-filled args.

## 0.7.0

### Minor Changes

- d7e3e33: **Streamable HTTP transport.** `querybridge-mcp-server` now supports two transports: the existing stdio (default, what Claude Code uses) and HTTP (for Cursor, n8n, hosted agents, browser-based clients). Implements the [MCP Streamable HTTP spec](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports) with stateful sessions, so log forwarding (`notifications/message`) and progress (`notifications/progress`) work end-to-end over HTTP.

  **Quick start:**

  ```bash
  export QUERYBRIDGE_MCP_HTTP_TOKEN=$(openssl rand -base64 32)
  querybridge-mcp-server --transport=http --port=8080
  ```

  ```json
  {
    "mcpServers": {
      "querybridge-mcp": {
        "type": "streamable-http",
        "url": "http://127.0.0.1:8080/mcp",
        "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
      }
    }
  }
  ```

  **Flags:** `--transport=stdio|http`, `--port`, `--host` (default `127.0.0.1`), `--path` (default `/mcp`), `--allowed-hosts`, `--no-auth`, `--cors-origin`.

  **Security defaults:**
  - **Bearer auth required.** `QUERYBRIDGE_MCP_HTTP_TOKEN` env var; server refuses to start otherwise. Two-key opt-out (no token AND `--no-auth`) prevents accidentally disabling auth via env-var typo.
  - **Loopback by default** (`127.0.0.1`). External binding requires `--allowed-hosts` for DNS-rebinding protection.
  - **No CORS by default** — opt in per-origin with `--cors-origin`.
  - **Body size capped at 4MB.**
  - **Constant-time token comparison.**
  - **All security guarantees of the stdio transport still apply** — read-only enforcement, LOAD INFILE block, KILL QUERY cancellation, error sanitization.

  **Container:** the Docker image now `EXPOSE`s 8080. Usage example in the Dockerfile and README.

  **Tests:** 17 new tests (bearer validation, startup guards, end-to-end MCP handshake against a live local server). Total now 349 unit + 15 integration.

  **No new runtime dependencies.** The transport uses Node's built-in `http` module + the SDK's `StreamableHTTPServerTransport`.

- babdddc: **New tool: `streaming_query`.** Stream a SELECT to a NDJSON file on disk — for exports that would blow `execute_query`'s 1k-row in-memory cap.

  Designed for the "dump this large table so the agent can grep/aggregate it without spending its response budget on the data" workflow. Uses mysql2's row-streaming API so the rows never sit in memory all at once; writes to a temp file + atomic rename so a mid-stream failure leaves no half-written file at the destination.

  **Inputs:**
  - `connection` (string, required)
  - `query` (string, required) — SELECT or read-only WITH … SELECT
  - `output_path` (string, required) — relative paths resolve against the server's cwd
  - `max_rows` (number, optional) — default 1,000,000; ceiling 100,000,000
  - `max_bytes` (number, optional) — default 1 GiB; ceiling 10 GiB
  - `overwrite` (boolean, optional) — default false; refuses to clobber otherwise

  **Safety:**
  - SELECT-only at the tool boundary, regardless of the connection's `readonly` flag — writing to disk is the side-effect; running write SQL while also serializing rows to a file would be confusing.
  - Refuses paths under `/proc/`, `/dev/`, `/sys/`, `/boot/`.
  - Refuses to clobber existing files unless `overwrite: true`.
  - Row and byte caps both apply — hitting either marks the result `truncated: true` and issues `KILL QUERY` against the worker so MySQL stops sending. Default caps bound the disk-DoS blast radius for HTTP-mode (authenticated remote) callers.
  - Atomic rename: writes to `${output_path}.tmp` and renames on success; on failure the temp file is unlinked.

  **Progress notifications.** Every 1000 rows the tool emits `notifications/progress` with `{ progressToken, progress, total, message }` when the client opts in via `_meta.progressToken`. Best-effort: a failing `sendNotification` (flaky client) is swallowed so it doesn't abort the export mid-write.

  **Tests:** 20 new unit tests (path validation, pre-stream gates, `pumpStream` cadence + cap-stop + sendNotification error-tolerance against a synthetic `Readable`) and 4 new integration tests against MySQL 8.4 (full export, row-cap truncation, byte-cap truncation, write-SQL rejection on writable connection).

## 0.6.0

### Minor Changes

- 8eff6eb: **Architecture & observability overhaul.** Same MCP behavior, dramatically better internals.

  User-visible improvements:
  - **Typed error responses with stable codes and hints.** Read-only violations, missing connections, malformed EXPLAIN output, and client cancellations now surface with grep-able codes (`READ_ONLY_VIOLATION`, `CONNECTION_NOT_FOUND`, `CANCELLED_BY_CLIENT`, …) and operator-facing remediation hints. Logs carry the code; clients see the hint.
  - **Automatic single-retry on transient pool failures.** SSH bastions occasionally drop idle tunnels between requests; mysql2's first reconnect attempt sometimes fails with `ECONNRESET` or `PROTOCOL_CONNECTION_LOST`. Pool acquisition now retries once after a brief sleep before surfacing the error. User queries are never retried — only the acquisition step.
  - **Per-request trace IDs in logs.** Every log line within a tool invocation carries the same `traceId`, propagated automatically through async boundaries via `AsyncLocalStorage`. Operators can now grep a single ID to follow a multi-step tool call.

  Internals (no behavior change, but a much better codebase to work in):
  - **Single `helpers.ts` (491 LOC, 9 unrelated concerns) → focused leaf modules** under `src/` (`paths`, `format`, `log`, `tool-runtime`, `limits`, `errors`) and `src/{sql,db,types,server}/`.
  - **Shared `db/introspection.ts`** centralizes information_schema reads previously duplicated across compare-tools, resources, and CLI autocomplete. Also serves as the unit-test seam — mocking `queryWithTimeout` here is enough to drive any handler without testcontainers.
  - **`withCancellableQuery` + `withTransientRetry`** under `src/db/`. The KILL-QUERY pattern that was duplicated between `execute_query` and `explain_query` is now one implementation.
  - **`CONVENTIONS.md`** codifies the layering, the tool contract, the error model, security invariants, and testing rules.
  - **`.dependency-cruiser.cjs`** enforces the layering rules at build time. Circular imports and accidental upward dependencies fail CI instead of waiting for review.
  - **`src/index.ts` and `src/cli.ts` moved to `src/server/`** to make the transport boundary explicit. `package.json` bin entries and the Dockerfile ENTRYPOINT are updated; users see no change.
  - **Removed all non-null assertions** in tool code. The remaining `any` is documented (single site: `ToolExtra.sendNotification` to dodge the SDK's narrow discriminated-union signature).
  - **332 unit tests** (was 254) and 15 integration tests — new handler-level coverage now possible thanks to the introspection seam.

## 0.5.1

### Patch Changes

- a086004: **Docker image tag fix.** The release workflow now publishes images under **three** tags: the bare semver (`:0.5.0`), the git-tag form (`:v0.5.0`), and `:latest`. Previously only the bare semver and `:latest` were tagged, which mismatched the README's documented `:vX.Y.Z` form and caused 0.5.0 pulls using `:v0.5.0` to fail. Both naming conventions are common in the ecosystem; shipping both means either form works.

## 0.5.0

### Minor Changes

- 9530a9e: **New tool: `compare_schemas`.** Diff two databases — same connection or cross-connection (staging vs prod is the canonical case). The richest single-tool addition this release.

  **Scopes** (all on by default; pass a subset for cheaper runs on huge schemas):

  | Scope             | What it covers                                                                                                                     |
  | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
  | `tables`          | Existence — present in source / target / both                                                                                      |
  | `tableAttributes` | Engine (InnoDB vs MyISAM), default charset, collation, comment, row format, **partitioning** (method, expression, partition count) |
  | `columns`         | Type, nullable, default, key, comment, EXTRA, generated-column expression                                                          |
  | `indexes`         | Columns, uniqueness, type, **MySQL 8 invisible indexes**, prefix lengths, functional-index expressions                             |
  | `foreignKeys`     | Columns, referenced table/columns (composite-FK aware), ON UPDATE/DELETE                                                           |
  | `views`           | Definition (whitespace-normalized), updatability, security type, check option                                                      |
  | `routines`        | Procedure/function, parameter signature, body, security, deterministic, data access                                                |
  | `triggers`        | Table, event, timing, orientation, body                                                                                            |
  | `events`          | Type, interval, status, body                                                                                                       |

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

- 9841736: **Docker support.** A multi-arch (amd64 + arm64) image is now published to `ghcr.io/mahmoudhassanmustafa/querybridge-mcp` on every release. Register with Claude Code without installing Node or pnpm:

  ```bash
  claude mcp add querybridge-mcp -- \
    docker run --rm -i \
    -v /path/to/config.json:/config/config.json:ro \
    -e QUERYBRIDGE_MCP_CONFIG=/config/config.json \
    ghcr.io/mahmoudhassanmustafa/querybridge-mcp:latest
  ```

  The image is multi-stage (build + slim runtime), runs as non-root, ships with SBOM + Sigstore provenance, and is ~250MB. README has the full setup including SSH key mounts. See the new "Register with Claude Code via Docker" section.

## 0.4.1

### Patch Changes

- 3419cc7: **Release plumbing fixes** (no user-facing code change):
  - `release.yml` accepts `workflow_dispatch` so failed/missed releases can be replayed with `gh workflow run release.yml --ref vX.Y.Z`.
  - `changeset.yml` now prefers a `CHANGESETS_PAT` secret (fine-grained PAT) over `GITHUB_TOKEN`, so tags it creates fire `release.yml` automatically instead of being silently swallowed by GitHub's anti-loop protection. Falls back to `GITHUB_TOKEN` when the secret is absent (no hard break).
  - CONTRIBUTING.md documents the required `NPM_TOKEN` and `CHANGESETS_PAT` secrets and the manual-replay command.

- 124fa42: **Release plumbing fix.** Pass `CHANGESETS_PAT` to `actions/checkout` so git operations (the version-bump commit and the release tag push) are attributed to the PAT owner instead of `github-actions[bot]`. Without this, GitHub's anti-loop protection swallows downstream workflow triggers — CI on the version PR and `release.yml` on the release tag both fail to fire. The env-var `GITHUB_TOKEN` override on `changesets/action@v1` only affected its API calls, not the underlying git operations.
- 335d0b1: - **`--version` / `-v`** now works on both binaries (`querybridge-mcp-server` and `querybridge-mcp`) and short-circuits before config loading — handy for sanity-checking the installed version without setting up a database.
  - The reported version is read from `package.json` at runtime, so it stays in sync with Changesets bumps automatically (the previous hardcoded `"0.1.3"` string in `src/index.ts` was already stale on 0.4.0).
  - `release.yml`'s `workflow_dispatch` now takes a required `tag` input. Stuck releases replay with `gh workflow run release.yml --ref main -f tag=vX.Y.Z` instead of needing the operator to push the tag from a non-`GITHUB_TOKEN` session.

## 0.4.0

### Minor Changes

- b2f2753: Major hardening, modernization, and capability release.

  **Security & safety**
  - Server-side read-only enforcement via `SET SESSION transaction_read_only = 1, sql_safe_updates = 1` on every pool connection. Even if the SQL-text whitelist were ever bypassed, MySQL itself rejects writes on read-only connections.
  - `LOAD DATA LOCAL INFILE` disabled at the client level (`LOCAL_FILES` capability dropped + `infileStreamFactory` throws) — a hostile MySQL server cannot read files from the MCP host.
  - Secrets indirection: `password`, `ssh.password`, `ssh.passphrase` accept `{ env: "VAR" }` or `{ file: "/path" }` so plaintext credentials don't need to live in `config.json`.

  **Modern MCP SDK**
  - All tools, resources, and prompts migrated from the deprecated `server.tool()` family to `registerTool` / `registerResource` / `registerPrompt`.
  - Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients can gate confirmation prompts appropriately.
  - `structuredContent` JSON alongside the formatted text output, so clients that support the modern MCP spec render rich tables instead of monospace ASCII.
  - Cancellation: `execute_query` and `explain_query` honor `RequestHandlerExtra.signal` — capture `CONNECTION_ID()` and on abort issue `KILL QUERY <id>` on a sibling connection so the statement is stopped at the server, not just abandoned by the client.
  - Server logs forwarded to the MCP client via `notifications/message` (per spec). The `logging` capability is advertised.

  **New tools (24 total, up from 20)**
  - `list_processes` — running connections + queries.
  - `kill_query` — cancel a query by process ID, gated on `readonly: false`.
  - `get_unused_indexes` — finds secondary indexes with zero reads in `performance_schema`, emits `ALTER TABLE ... DROP INDEX` statements.
  - `get_charset_collation` — DB → table → column charset/collation drill-down.

  **Other capability changes**
  - `execute_query.params` accepts `{"$binary": "<base64>"}` for BLOB values.
  - Configurable per-connection pool size via `poolSize` (default 5, max 50).
  - Audit log on every tool invocation (INFO on success, WARN with `rejected:true` on precondition failures).

  **Foundational**
  - Config validated via a single Zod schema (file, inline JSON, env vars all use one path).
  - Shared SSH tunnel helper — the CLI's `test` command now gets the same fingerprint pinning and keepalives as the long-lived server.
  - Stricter tsconfig: `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`. Several latent bugs surfaced and fixed.

  **Tooling & supply chain**
  - ESLint flat config with `typescript-eslint`. Prettier config (no bulk reformat yet).
  - Node 20 / 22 / 24 CI matrix. **Node 18 is no longer supported** (`engines.node: ">=20"`) — it reached EOL on 2025-04-30.
  - `packageManager` field pinned to `pnpm@10.24.0` for Corepack.
  - `npm pack --dry-run` check in CI hard-fails if test files would ship to npm.
  - Release workflow publishes to npm with **Sigstore provenance** (`--provenance`).
  - Changesets manages version bumps and `CHANGELOG.md` from now on.
  - Dependabot, CODEOWNERS, PR template, issue forms.

  **Integration tests**
  - `@testcontainers/mysql`-based integration suite verifies the behaviors unit tests cannot reach (server-side RO enforcement, `LOAD DATA LOCAL INFILE` block, KILL QUERY cancellation, real `information_schema` queries). A bug in the original session-hardening implementation was caught and fixed by this suite.

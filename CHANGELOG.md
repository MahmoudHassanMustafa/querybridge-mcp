# querybridge-mcp

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

# querybridge-mcp

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

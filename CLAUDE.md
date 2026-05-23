# CLAUDE.md

Operational notes for agents working in this repo. **Read `CONVENTIONS.md` for the full set of rules**; this file is the 60-second briefing.

## Quick orientation

- **What it is.** An MCP server connecting Claude (and other MCP clients) to MySQL. Ships two transports: **stdio** (default) and **Streamable HTTP** (with bearer auth). 39 tools across 9 families (see `README.md` → Tools).
- **Stack.** TypeScript, Node ≥ 20, **pnpm** (not npm — `packageManager` field in `package.json`), Vitest, `mysql2/promise`, `ssh2`, `@modelcontextprotocol/sdk`.
- **Architecture.** `Transport → Tools → Infrastructure`. Enforced by `.dependency-cruiser.cjs`; `CONVENTIONS.md` §1 has the prose. Don't import upward.
- **Entry points.** `src/server/index.ts` dispatches stdio vs HTTP. `src/tools/index.ts` is the tool-registry barrel.

## Commands

```bash
pnpm install            # also installs the husky pre-commit hook via `prepare`
pnpm build              # tsc
pnpm lint               # eslint + dep-cruiser (architecture enforcement)
pnpm test               # unit tests (Vitest)
pnpm test:integration   # MySQL Testcontainers — needs Docker running
pnpm format             # prettier --write across the repo
pnpm format:check       # prettier --check (no writes) — what CI would run
```

`pnpm lint && pnpm test` covers everything CI does. The pre-commit hook handles the formatting + ESLint pass on staged files automatically — no need to remember `pnpm format` before each commit.

## Release flow

Changesets-driven. **Never bump versions manually.**

- Any user-visible change → add `.changeset/<short-name>.md` with the appropriate bump (`patch` / `minor` / `major`) and a clear changelog entry.
- Merging to main triggers the Changesets bot to open or update a "Version Packages" PR.
- Merging the Version Packages PR pushes a `vX.Y.Z` tag → `release.yml` publishes to npm (with Sigstore provenance) and GHCR (multi-arch + SBOM).

## Hard rules

- **Never commit `config.json`.** It contains DB credentials. `config.example.json` is the sanitized template.
- **Never skip pre-commit hooks** (`--no-verify`). The hook (`.husky/pre-commit`) runs `lint-staged`, which calls `eslint --fix --max-warnings=0` and `prettier --write` on staged files only. Fast (~1s typical) and fixable — if it fails, fix the root cause instead of bypassing.
- **Never reach for `mysql2` outside `src/connection.ts`, `src/db/cancel.ts`, or `src/tools/query-tools.ts`.** Pool hardening (`LOCAL_FILES` block, SSL setup, `SET SESSION transaction_read_only`) only happens in `buildPoolOptions`. Bypassing it loses defenses. `dep-cruiser` enforces.
- **Every new tool ships with an integration test.** `MockRunner` unit tests are not enough — real MySQL catches behavior the mock doesn't (CONVENTIONS.md §8).
- **Read-only by default.** Two layers, both required: `getConnectionConfig().readonly` flag check AND `isReadOnlyQuery()` SQL whitelist. Don't skip either.
- **`config.json` is gitignored** but `.changeset/config.json` is not — the gitignore has a `!.changeset/config.json` negation. Don't break it.

## Common gotchas

- **Promise vs callback connection.** mysql2's `.stream()` only exists on the underlying callback connection. From a promise pool's worker, reach via `worker.connection.query(sql).stream()`. See `src/tools/streaming-tools.ts` for the working pattern.
- **`exactOptionalPropertyTypes` is on.** Optional Zod fields infer as `T | undefined`; matching interface properties must spell out `T | undefined` (not bare `T?`) to be assignable under EOP. SDK tool-handler return types also expect an open `[key: string]: unknown` index signature on the result — see how `ToolErrorResult` is shaped in `src/tool-runtime.ts`.
- **`noImplicitOverride` is on.** Subclass fields that exist on a base class need the `override` modifier (e.g. `override readonly suggestions = [...]` on `QueryBridgeError` subclasses).
- **`MockRunner` only matches `.query()` calls.** Any tool that reaches `getPool()` (e.g. `streaming_query`, `execute_query`'s KILL path) cannot be unit-tested with mocks — those paths live in the integration suite.
- **Logging.** Use `log(level, msg, ctx?)` from `src/log.ts`. The local ESLint plugin forbids `${var}` interpolation in messages — variables go in the third-arg context object so operators can grep on stable JSON fields.
- **Error responses.** Anticipated failures: `return toolError(msg, { code, hint, suggestions? })`. Typed failures: `throw` a `QueryBridgeError` subclass — `toolHandler` converts it and forwards the `code` + `suggestions`. System errors (mysql2 throws, dropped connections): just `throw` — `toolHandler` sanitizes the message.
- **`tables: string[]` dual-shape.** Several schema tools (`describe_table`, `get_ddl`, `get_foreign_keys`, `get_indexes`, `get_table_stats`) accept either `table: string` (flat shape) or `tables: string[]` (returns `{ results: [...] }`). When adding a new schema-introspection tool that benefits from batch lookup, mirror this pattern — single-table mode keeps the existing flat response for back-compat; batch mode wraps each per-table payload in a `results` array. Dedup `tables`/`table` via `Set` before fanning out.
- **SQL template lint rule** (`local/sql-template-no-bare-identifier`). Bare-identifier interpolation in a `sql`-tagged template — passing a variable directly into the template, e.g. `${table}` — is flagged as an injection foot-gun. The rule whitelists `CallExpression` children (e.g. `escapeId(table)`), so the fix is to wrap the identifier in a call rather than passing the bare variable. If the keyword itself is dynamic (e.g. `GLOBAL` / `SESSION`), drop the `sql` tag and use plain string concatenation — the rule only fires on tagged templates whose first token is a SQL keyword.

## Where things live

- `src/server/` — transport layer (stdio + HTTP) + admin CLI
- `src/tools/` — every MCP tool, one file (or directory) per family
- `src/db/` — repository helpers (introspection, cancel, retry, resolve, runner)
- `src/sql/` — SQL primitives (identifier escape, read-only whitelist)
- `src/tool-runtime.ts` — `toolHandler` middleware, `toolError` / `toolOk`, progress emission
- `src/errors.ts` — typed error taxonomy (`QueryBridgeError` + subclasses)
- `src/limits.ts` — every centralized constant (timeouts, budgets, chunk sizes) with its rationale inline
- `src/__tests__/` — unit (`*.test.ts`) and integration (`integration/*.integration.test.ts`)
- `eslint-plugins/local.js` — in-repo ESLint rules codifying CONVENTIONS.md §9
- `.husky/pre-commit` + `lint-staged` config in `package.json` — runs ESLint + Prettier on staged files only on every commit
- `.editorconfig` — cross-editor indent/EOL/charset defaults (mirrors `.prettierrc.json` for contributors who don't have Prettier on save)
- `CONVENTIONS.md` — the §1-§9 rules. Read this before any non-trivial change.
- `CONTRIBUTING.md` — the dev loop end-to-end.

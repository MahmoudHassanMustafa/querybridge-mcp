# CLAUDE.md

Operational notes for agents working in this repo. **Read `CONVENTIONS.md` for the full set of rules**; this file is the 60-second briefing.

## Quick orientation

- **What it is.** An MCP server connecting Claude (and other MCP clients) to MySQL. Ships two transports: **stdio** (default) and **Streamable HTTP** (with bearer auth). ~30 tools.
- **Stack.** TypeScript, Node ≥ 20, **pnpm** (not npm — `packageManager` field in `package.json`), Vitest, `mysql2/promise`, `ssh2`, `@modelcontextprotocol/sdk`.
- **Architecture.** `Transport → Tools → Infrastructure`. Enforced by `.dependency-cruiser.cjs`; `CONVENTIONS.md` §1 has the prose. Don't import upward.
- **Entry points.** `src/server/index.ts` dispatches stdio vs HTTP. `src/tools/index.ts` is the tool-registry barrel.

## Commands

```bash
pnpm install
pnpm build              # tsc
pnpm lint               # eslint + dep-cruiser (architecture enforcement)
pnpm test               # unit tests (Vitest)
pnpm test:integration   # MySQL Testcontainers — needs Docker running
```

Run `pnpm lint && pnpm test` before any commit. CI runs the same on Node 20/22/24 + integration + a Docker build.

## Release flow

Changesets-driven. **Never bump versions manually.**

- Any user-visible change → add `.changeset/<short-name>.md` with the appropriate bump (`patch` / `minor` / `major`) and a clear changelog entry.
- Merging to main triggers the Changesets bot to open or update a "Version Packages" PR.
- Merging the Version Packages PR pushes a `vX.Y.Z` tag → `release.yml` publishes to npm (with Sigstore provenance) and GHCR (multi-arch + SBOM).

## Hard rules

- **Never commit `config.json`.** It contains DB credentials. `config.example.json` is the sanitized template.
- **Never skip pre-commit hooks** (`--no-verify`). They run lint. If a hook fails, fix the root cause.
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
- `CONVENTIONS.md` — the §1-§9 rules. Read this before any non-trivial change.
- `CONTRIBUTING.md` — the dev loop end-to-end.

# Conventions

This document codifies the conventions that the querybridge-mcp codebase
follows. It is the source of truth for code reviews and the bar new code
must clear. When the code disagrees with this document, the document wins —
file an issue or fix the drift.

The goal is not theoretical purity. It is to keep the codebase boring to
read and predictable to change.

---

## 1. Architecture & layering

The server is organised in three layers. Imports must flow downward only.

```
┌──────────────────────────────────────────────────────────┐
│  Transport          src/server/{index,cli}.ts            │
│  (MCP wiring,       src/resources.ts, src/prompts.ts     │
│   process lifecycle)                                     │
└──────────────────────────────────────────────────────────┘
              │ depends on
              ▼
┌──────────────────────────────────────────────────────────┐
│  Tools              src/tools/*.ts                       │
│  (one file per tool family, registered via               │
│   registerXxxTools(server))                              │
└──────────────────────────────────────────────────────────┘
              │ depends on
              ▼
┌──────────────────────────────────────────────────────────┐
│  Infrastructure     src/connection.ts (pool + SSH)       │
│                     src/ssh-tunnel.ts                    │
│                     src/config.ts, src/schema.ts         │
│                     src/helpers.ts (and its successors)  │
│                     src/types.ts                         │
└──────────────────────────────────────────────────────────┘
```

Rules:

- **Tools never import from `src/server/`.** Transport depends
  on tools, never the other way around.
- **Infrastructure never imports from `tools/`.** A helper that needs
  knowledge of a specific tool belongs in that tool, not in infrastructure.
- **`tools/index.ts` is a barrel only.** It exists to register all tool
  families with a single call. No logic.
- **One tool family per file.** `connection-tools`, `query-tools`,
  `schema-tools`, `data-tools`, `routines-tools`, `admin-tools`,
  `compare-tools`, `erd-tool`. A file may register multiple tools, but
  every tool in a file must share the same theme.
- **Cohesion test, not a line cap.** A file should be summarizable in
  one sentence about what it does. `helpers.ts` (491 LOC, 9 unrelated
  jobs) fails this; `compare-tools.ts` (1311 LOC, all one pipeline)
  passes. Long but cohesive is fine; medium and miscellaneous is not.
- **No circular imports.** Infrastructure modules must form a DAG.
  `helpers.ts` ↔ `connection.ts` was a real cycle (resolveDb called
  back into connection); the split into `log.ts` / `tool-runtime.ts` /
  `sql/*` exists to keep this property.

---

## 2. The tool contract

Every MCP tool in this server **must** follow this shape, no exceptions:

```ts
server.registerTool(
  "tool_name",                                  // snake_case, matches the LLM-facing name
  {
    title: "Human-readable title",              // shown in tool pickers
    description: "What it does and when to use it.",
    inputSchema: { /* zod schemas */ },
    annotations: { /* hints — see below */ },
  },
  toolHandler("tool_name", async (args, extra) => {
    // 1. Validate / resolve preconditions
    // 2. Acquire resources
    // 3. Do the work
    // 4. Return toolOk(text, structured) | toolError(message, hint)
  }),
);
```

### 2.1 Wrap every handler in `toolHandler`

Every handler is wrapped with `toolHandler(toolName, fn)`. This is
non-negotiable. The wrapper:

- Logs every invocation (info on success, warn on rejection, warn on throw).
- Records `elapsedMs` and `connection`.
- Catches throws, sanitizes MySQL error messages (`'user'@'host'` and
  IP redaction), and returns a `toolError` to the client.

If a handler is not wrapped, a thrown error leaks raw MySQL diagnostics
to the LLM. Treat an unwrapped handler as a security bug.

### 2.2 Return shape

Always return one of:

- `toolOk(text, structuredContent?)` — success.
- `toolError(message, hint?)` — predictable failure (read-only violation,
  resource not found, validation error). Use `hint` to tell the operator
  what to change.

Never construct `{ content: [...] }` manually in a tool.

### 2.3 Annotations are part of the contract

Every tool must specify all four annotation hints explicitly:

| Annotation | Set to `true` when |
|------------|--------------------|
| `readOnlyHint` | Tool only reads — no mutation of DB or server state |
| `destructiveHint` | Tool can lose data when misused |
| `idempotentHint` | Same args → same effect, repeatable safely |
| `openWorldHint` | Tool issues a query against an external DB. `false` for tools that only inspect server-local state (e.g. `list_connections`). |

For read-only introspection tools, prefer the shared constant pattern:

```ts
const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;
```

### 2.4 Input validation

- All inputs go through a zod schema in `inputSchema`. Never trust raw
  args.
- Validation belongs in zod — not in the handler body. If the handler
  starts doing type checks on `args.foo`, the zod schema is wrong.
- `connection: z.string()` is the first arg of every DB-touching tool.
- `database: z.string().optional()` for tools that target a schema;
  resolve with `resolveDb(connection, database)` (do not roll your own
  fallback to `getConnectionConfig`).

### 2.5 Cancellation

Long-running tools (queries, EXPLAIN, schema comparisons) must honour
`extra.signal`. The pattern:

1. Capture `CONNECTION_ID()` on the worker connection.
2. On `signal.abort`, open a sibling connection and issue `KILL QUERY`.
3. Distinguish "killed by us" from other errors so the client sees
   `"Query was cancelled by the client"` rather than a raw MySQL error.
4. Remove the abort listener in `finally`; release the worker connection
   in `finally`.

This pattern is duplicated in `execute_query` and `explain_query` today —
extract `createAbortListener(pool, connection)` and reuse it.

### 2.6 Progress reporting

Multi-step tools (compare_schemas, generate_erd) may call
`emitProgress(extra, progress, total, message?)`. It no-ops when the
client did not pass a progressToken; it never throws. Use it for
operations that can take >2 seconds on real-world schemas.

---

## 3. Connection lifecycle

`src/connection.ts` owns all mysql2 + SSH state. Other files **must
not** call `mysql.createPool` or import `mysql2` directly for pool
creation. The boundary is:

- **Read once at startup:** `loadConfig()` → `initConnection(cfg)` per
  database → pool is registered in the module-private `connections` map.
- **Use during tools:** `getPool(name)`, `queryWithTimeout(name, sql,
  params)`, `getConnectionConfig(name)`, `getQueryTimeout(name)`.
- **Tear down on shutdown:** `closeAll()` — pools first, then SSH
  tunnels.

Rules:

- **Always release.** Every `pool.getConnection()` must be paired with
  `conn.release()` in `finally`. Use `queryWithTimeout` whenever you do
  not need the underlying connection — it handles release for you.
- **Prefer `queryWithTimeout`** for one-shot reads. Only reach for
  `pool.getConnection()` when you need session affinity (e.g. capturing
  `CONNECTION_ID()` for cancellation, or running `USE` before a user
  query).
- **Tunnels must die with the pool.** If `initConnection` throws after
  creating an SSH tunnel, the tunnel must be closed. The current
  implementation does this for pool-creation failures; extend it to
  cover the gap before the `try` block as well.
- **All queries that touch `information_schema` use `queryWithTimeout`.**
  These are the queries most likely to be slow on large servers.

---

## 4. Types

### 4.1 Where types live

- **`src/types.ts`** — config types (re-exports from `schema.ts`).
- **`src/schema.ts`** — zod schemas and their inferred types.
- **`src/types/db.ts`** — shared normalized domain types: `Column`,
  `IndexDef`, `ForeignKey`, `TableAttributes`, `View`, `Routine`,
  `Trigger`, `Event`, and the `BaseDiff<T>` family. A type belongs
  here only if **two or more modules** consume it.
- **In the tool file** — types used by only one tool, including
  one-off row types for a specific SQL query. Don't preemptively
  promote single-consumer types to `db.ts`.

### 4.2 Avoid `Record<string, unknown>` for query results

Every `queryWithTimeout<Array<Record<string, unknown>>>` is a typing
debt. Define a concrete row type next to the SQL that produced it:

```ts
interface TableRow {
  TABLE_NAME: string;
  TABLE_ROWS: number | null;
  ENGINE: string | null;
  TABLE_COMMENT: string | null;
}
const rows = await queryWithTimeout<TableRow[]>(connection, sql, params);
```

Row types live next to their SQL when the SQL is unique to one tool,
and in `types/db.ts` when shared.

### 4.3 No `any`

`any` is banned. The single allowed exception is
`ToolExtra.sendNotification`, which is documented inline. New `any`
requires an eslint-disable with a justification comment.

### 4.4 Exported functions need explicit return types

All exported functions in `src/` declare their return type. `tsc` is
strict; an inferred `Promise<unknown>` is rarely what you wanted.

---

## 5. Error handling & logging

### 5.1 Logging

- **`log(level, msg, ctx?)`** is the only logger. Never use
  `console.log` / `console.error` directly in business code.
- **Stdout is reserved for the MCP transport.** Logs go to stderr +
  optional MCP `notifications/message`.
- **Levels:**
  - `info` — successful tool invocations, lifecycle events.
  - `warn` — handled failures (read-only rejections, tunnel closures
    on shutdown, failed log forwarding).
  - `error` — unhandled rejections, fatal startup failures.
- **Always include context as the third arg**, never interpolate into
  the message. `log("warn", "kill failed", { connection, error })` —
  not `log("warn", \`kill failed on ${connection}: ${error}\`)`.

### 5.2 Error model

Three kinds of errors flow through this server:

1. **User errors** (bad input, read-only violation, table not found) —
   return `toolError(message, hint)`. Never throw.
2. **System errors** (MySQL timeout, tunnel drop, OOM) — let them
   throw. `toolHandler` catches, logs the raw message, returns a
   sanitized `toolError` to the client.
3. **Cancellation** (`extra.signal.abort`) — return
   `toolError("Request was cancelled…")`. Distinguish from system
   errors by tracking a `killed` flag.

### 5.3 Sanitize before returning, log raw

`toolHandler` runs MySQL error messages through `sanitizeErrorMessage`
before returning them to the client. The raw message goes to the
operator log. Do not skip sanitization for "internal" tools — every
tool result reaches the LLM.

---

## 6. Security invariants

These rules are not negotiable. Code that violates them does not merge.

1. **Identifiers (table, column, db names) go through `escapeId`.**
   Never `\`${table}\``. Use `qualifiedTable(db, table)` for the
   common case.
2. **Values go through `?` placeholders.** Never interpolate a value
   into a SQL string. The narrow exception is `KILL QUERY <id>` /
   `KILL CONNECTION <id>` — MySQL does not accept placeholders for
   these. Guard with `Number.isInteger(id) && id > 0` before
   interpolating.
3. **Read-only enforcement uses `isReadOnlyQuery` / `isExplainSafe`.**
   These strip comments before keyword checks. If you bypass them,
   `WITH cte AS (SELECT 1) DELETE …` becomes a write-through.
4. **Connection defaults to `readonly: true`.** Operators opt in to
   writes per-connection.
5. **`LOAD DATA LOCAL INFILE` is disabled at three layers** in
   `initConnection`: flag, factory, and explicit option. All three
   must stay.
6. **SSH host key fingerprints are checked with `timingSafeEqual`.**
   Don't switch to `===` even when "it's just a hash".
7. **Secrets are resolved at config-load time** via `secretSchema`
   (literal | env | file). New secret-bearing fields use this schema —
   never `z.string()` directly.

---

## 7. Code style

- **`tsc --strict` + `exactOptionalPropertyTypes` are on.** Build
  incrementally instead of emitting explicit `undefined`.
- **Comments explain WHY, not WHAT.** Magic numbers must carry a
  rationale comment (see `MAX_OUTPUT_BYTES`, `MAX_COL_WIDTH`,
  `MAX_RESULT_ROWS` for the bar).
- **`as const` for literal-typed objects** (annotation constants, level
  maps).
- **No `null` returns for optional config.** Use `T | undefined`.
- **ESM imports use `.js` extensions** — Node ESM resolution requires
  it for relative imports.
- **Magic numbers belong in a `src/limits.ts` module** (to be
  created), not scattered across files. Each constant ships with a
  rationale comment.

---

## 8. Testing

- **Unit tests** live in `src/__tests__/*.test.ts` — pure functions,
  no MySQL. Run with `pnpm test`.
- **Integration tests** live in `src/__tests__/integration/` and use
  `@testcontainers/mysql`. Run with `pnpm test:integration`. They
  must hit a real MySQL, never a mock.
- **Every helper in `helpers.ts`** has unit tests in `helpers.test.ts`.
  `isReadOnlyQuery`, `stripSQLComments`, and `escapeId` are
  security-critical — add adversarial inputs whenever you touch them.
- **A new tool ships with at least one integration test** that
  exercises the happy path against a testcontainer MySQL.

---

## 9. Things to enforce mechanically

These rules exist today but are enforced by review only. Move them
into tooling as we get to them:

- ESLint rule: no direct `console.*` outside `src/server/`.
- ESLint rule: tool files must call `toolHandler` (no raw `async
  (args) => ({ content: ... })`).
- ESLint rule: no string interpolation of values into SQL template
  literals (allow identifiers escaped via `escapeId` / `qualifiedTable`).
- `dependency-cruiser` config: the layering rules in §1.
- `tsc` `noUncheckedIndexedAccess` should be enabled and the resulting
  call sites fixed.

---

## Decided

- **`compare-tools.ts` splits by phase, not by entity.**
  `src/tools/compare/{index,fetchers,diff,normalize,render}.ts` —
  every aspect (tables, views, routines, …) goes through the same
  fetch → diff → render pipeline, so phase boundaries beat entity
  folders.
- **One-off query result types stay co-located.** Only normalized
  domain types shared by two or more modules go in `src/types/db.ts`.
  See §4.1.
- **No `Result<T, E>` wrapper.** The MCP SDK expects exactly the
  `toolOk | toolError` envelope; another layer would double the
  unwrap ceremony without paying for itself. Stay with the
  discriminated shape.

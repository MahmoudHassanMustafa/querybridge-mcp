---
"querybridge-mcp": minor
---

**Architecture & observability overhaul.** Same MCP behavior, dramatically better internals.

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

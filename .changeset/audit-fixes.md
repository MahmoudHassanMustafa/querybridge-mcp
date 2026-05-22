---
"querybridge-mcp": patch
---

**Security: clear all `pnpm audit` advisories** by bumping transitive dependencies in the lockfile. No `package.json` ranges changed; no production code touched. Every bump stayed within the upstream constraint windows.

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

---
"querybridge-mcp": minor
---

**New tool: `compare_schemas`.** Diff two databases — same connection or cross-connection (staging vs prod is the canonical case). Reports tables, columns, indexes, and foreign keys that exist only in source, only in target, or differ between them.

Inputs: `sourceConnection`, `sourceDatabase?`, `targetConnection`, `targetDatabase?`, optional `tables[]` filter, optional `scope[]` for a cheaper subset (e.g. `["tables", "indexes"]`).

Outputs a structured JSON diff alongside a markdown summary, so modern clients can render rich UI while older ones still get readable text. Tables that are perfectly in sync get a one-line confirmation; only the differences appear.

This is also the first tool that emits MCP `notifications/progress`. Clients that pass a `progressToken` with the request see one tick per scope finished — useful for clients rendering a progress bar on large schemas.

Skips views, routines, triggers, and events on purpose — use the dedicated tools for those. No auto-generated migration SQL (intentional: too easy to get wrong, too dangerous to trust blindly).

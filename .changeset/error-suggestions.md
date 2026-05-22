---
"querybridge-mcp": minor
---

**LLM-friendly error responses.** Tool failures now carry structured `suggestions` — a list of `{ tool, reason, args? }` pointers an agent can act on programmatically — in addition to the existing human-readable `hint` text. Failed responses also include a stable `code` in `structuredContent` so agents branch on a fixed token instead of pattern-matching the message string.

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

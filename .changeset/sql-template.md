---
"querybridge-mcp": patch
---

**Internal: tagged `sql\`\`` template helper.** New `src/sql/template.ts` exports `sql`, `id`, and `raw` for assembling parameterized SQL with explicit identifier escaping and explicit-unsafe integer interpolation.

**Why:** three sites in the codebase need to inline a value MySQL doesn't accept `?` placeholders for — `KILL QUERY <id>`, `KILL CONNECTION <id>`, and `SHOW CREATE PROCEDURE/FUNCTION <db>.<name>`. Each previously used `// eslint-disable-next-line no-restricted-syntax` to silence the SQL-template lint rule. The new helper replaces those bypasses with `raw()` (runtime-checked finite integer) and `id()` (`escapeId`-wrapped identifier), so the unsafe-by-necessity intent is visible at the call site instead of being a silenced lint warning.

**API:**

\`\`\`ts
import { sql, id, raw } from "./sql/template.js";

await worker.query(sql\`KILL QUERY \${raw(connectionId)}\`);
await worker.query(sql\`SHOW CREATE PROCEDURE \${id(db)}.\${id(name)}\`);
await worker.query(sql\`SELECT * FROM users WHERE id = \${userId}\`);  // userId → ? param
\`\`\`

Returns `{ sql: string, values: unknown[] }`, directly compatible with mysql2's `query()` / `execute()` QueryOptions overload.

**No public behaviour change.** All migrated sites send the exact same SQL bytes to MySQL — the helper just makes how those bytes are assembled type-safe and lint-clean. Verified by the existing KILL-QUERY integration test still passing against MySQL 8.4.

**Tests:** 16 new unit tests for the helper (plain interpolation → parameter, `id()` identifier escaping, `raw()` integer guard, mixed slots in order, edge cases: null/undefined/NaN/Infinity/string-sneak-through).

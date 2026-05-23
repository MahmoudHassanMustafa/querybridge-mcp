---
"querybridge-mcp": minor
---

**New tool: `generate_migration`.** Advisory-only ALTER/CREATE/DROP SQL generator. Given a `source` schema (the desired state) and a `target` schema (the DB to modify), emits the SQL statements that — **if applied to target** — would bring it in line with source. **Never executes anything**; output is text + structured content for the operator to review and run manually.

### Safety model

- **Read-only at the MCP boundary** (`readOnlyHint: true` annotation). We don't open a writable connection to the target.
- **Destructive operations are opt-in.** Without `include_drops: true`, no DROP TABLE / DROP COLUMN / DROP INDEX / DROP FOREIGN KEY is emitted — the migration is purely additive. Without `include_destructive_changes: true`, no MODIFY COLUMN or re-creating-existing-index/FK statements.
- **Every destructive line is preceded by a `-- WARNING:` SQL comment** describing the specific risk (data loss, type narrowing, orphan rows after FK drop, etc.).
- **A full banner heads the output**: `⚠ ADVISORY MIGRATION SQL — DO NOT EXECUTE BLINDLY`, with a four-item review checklist. An operator scanning the response top-down sees the warning before any individual statement.

### Inputs

| Input                         | Required | Notes                                                                            |
| ----------------------------- | -------- | -------------------------------------------------------------------------------- |
| `sourceConnection`            | yes      | Holds the **desired** schema (e.g. staging, canonical)                           |
| `sourceDatabase`              | no       | Uses the connection's active db if omitted                                       |
| `targetConnection`            | yes      | Holds the DB that would be modified (e.g. prod)                                  |
| `targetDatabase`              | no       | Uses the connection's active db if omitted                                       |
| `tables`                      | no       | Restrict to specific table names                                                 |
| `include_drops`               | no       | Default `false`. Emit DROP statements for objects in target but not source       |
| `include_destructive_changes` | no       | Default `false`. Emit MODIFY COLUMN + re-create-index/FK for objects that differ |

### Phase ordering

Output is grouped into 9 phases ordered for safe sequential application:

1. Drop foreign keys (release FK constraints so we can modify referenced columns / drop tables)
2. Drop indexes
3. Drop columns
4. Modify columns (with type-narrowing warnings)
5. Add columns (NOT NULL columns without DEFAULT get a backfill-first warning)
6. Add indexes
7. Add foreign keys
8. Drop tables (after their FKs are gone)
9. Create new tables (CREATE TABLE from source's DDL)

### V1 scope

| Covered                                                                     | Skipped                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Table adds / drops                                                          | Views, routines, triggers, events                             |
| Column adds / drops / modifies                                              | Table-level attribute changes (engine, charset, partitioning) |
| Index adds / drops / modifies (functional, prefix, invisible all supported) | Per-column character set / collation overrides                |
| FK adds / drops / modifies with full ON UPDATE / ON DELETE                  | Data migrations — DDL only                                    |

PRIMARY KEY add/drop statements are **commented out** with a manual-review note: dropping or adding a PK on an existing table is rarely the right move and almost always indicates a schema redesign.

### Backed by the existing comparison engine

`generate_migration` reuses `runSchemaComparison` (same engine as `compare_schemas` and `compare_schema_file`) for the diff. The new SQL-emission logic lives in `src/tools/migration-tools.ts`. No comparison-engine changes — the migration tool sits on top of what's already shipping.

### Tests

6 new integration tests against MySQL 8.4 with a deliberately-diverged target schema (`migtgt` database with users.legacy_status to drop, missing users.created_at + orders.total to add, missing FK to add):

- `ADD COLUMN` for columns missing from target
- `ADD CONSTRAINT FOREIGN KEY` for missing FKs
- `include_drops: false` skips DROP COLUMN AND announces the skip in the output
- `include_drops: true` emits DROP COLUMN with a destructive warning
- Banner appears at the top regardless of args
- Identical source/target → 0 statements + "No migration statements generated"

Total: **41 integration tests** against MySQL 8.4. Build + lint clean (92 modules, 322 deps, 0 violations).

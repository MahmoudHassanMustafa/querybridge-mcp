import { resolveDb } from "../../db/resolve.js";
import {
  describeTableColumns,
  getCreateTable,
  getCreateTableRaw,
  getForeignKeys,
  getIndexStats,
  getViewDdl,
  listTablesDetailed,
  listViewsBrief,
  searchColumns,
  showIndexes,
} from "../../db/introspection.js";
import { formatAsTable } from "../../format.js";
import { toolOk, toolError, toolHandler } from "../../tool-runtime.js";

/**
 * Schema-introspection tool handlers.
 *
 * Each handler is exported as a `toolHandler`-wrapped function so the
 * registration file (`./index.ts`) wires them in declaratively and so
 * unit tests can import + invoke them with `registerMockConnection`
 * providing canned rows.
 */

export const handleListTables = toolHandler(
  "list_tables",
  async ({
    connection,
    database,
  }: {
    connection: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const tables = await listTablesDetailed(connection, r.db);
    if (tables.length === 0) {
      return toolOk("No tables found", { database: r.db, tables: [] });
    }
    return toolOk(
      formatAsTable(tables) + `\n\n${tables.length} table(s) in ${r.db}`,
      { database: r.db, tables },
    );
  },
);

/**
 * Pull columns + create-statement + indexes for one table.
 * Returns `null` when the target is actually a view (caller can
 * branch to the right error path).
 */
async function describeOneTable(
  connection: string,
  db: string,
  table: string,
): Promise<{
  table: string;
  columns: Awaited<ReturnType<typeof describeTableColumns>>;
  indexes: Awaited<ReturnType<typeof showIndexes>>;
  createStatement: string;
  isView: boolean;
}> {
  // Stage 1: columns + create-row in parallel. We need the create
  // row to know whether the target is actually a view — if it is,
  // skip the SHOW INDEX call entirely (it returns nothing for views
  // anyway and the extra query just wastes a round-trip).
  const [columns, createRow] = await Promise.all([
    describeTableColumns(connection, db, table),
    getCreateTableRaw(connection, db, table),
  ]);
  const isView =
    !!createRow && !createRow["Create Table"] && !!createRow["Create View"];
  const indexes = isView ? [] : await showIndexes(connection, db, table);
  return {
    table,
    columns,
    indexes,
    createStatement: createRow?.["Create Table"] ?? "",
    isView,
  };
}

export const handleDescribeTable = toolHandler(
  "describe_table",
  async ({
    connection,
    table,
    tables: tablesArg,
    database,
  }: {
    connection: string;
    table?: string | undefined;
    tables?: string[] | undefined;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    // Three accepted shapes:
    //   1. table: "users"            → flat single-table response (legacy)
    //   2. tables: ["a", "b"]        → array response { results: [...] }
    //   3. table: "x", tables: [...] → merged + deduplicated, array response
    // Choose the response shape based on whether `tables` was provided:
    // legacy callers passing just `table` keep the original flat shape;
    // anything that opts into `tables` (even a one-element array) gets
    // the new array shape. That's the cleanest backward-compat split.
    const useArrayShape = !!tablesArg && tablesArg.length > 0;
    const filterSet = new Set<string>();
    if (table) filterSet.add(table);
    if (tablesArg) for (const t of tablesArg) filterSet.add(t);
    const targets = [...filterSet];

    if (targets.length === 0) {
      return toolError("describe_table needs either `table` or `tables`.", {
        code: "DESCRIBE_TABLE_NO_TARGET",
        hint: 'Pass `table: "<name>"` for one table or `tables: [...]` for a batch.',
        suggestions: [
          {
            tool: "list_tables",
            reason: "see what's available to describe",
            args: { connection, database: r.db },
          },
        ],
      });
    }

    // Fetch every requested table in parallel. Each describeOneTable
    // runs three queries; mysql2's pool handles the concurrency.
    const results = await Promise.all(
      targets.map((t) => describeOneTable(connection, r.db, t)),
    );

    // ── single-table flat shape (legacy callers) ───────────────────
    if (!useArrayShape) {
      // targets is non-empty (guarded above), so Promise.all gave us
      // at least one entry. The explicit narrowing keeps TS happy
      // without a non-null assertion.
      const only = results[0];
      if (!only) {
        return toolError("describe_table internal error: no result", {
          code: "INTERNAL_NO_RESULT",
        });
      }
      if (only.isView) {
        return toolError(`"${only.table}" is a view, not a table.`, {
          code: "OBJECT_IS_VIEW",
          hint: "Use describe_view or get_view_ddl instead.",
          suggestions: [
            {
              tool: "describe_view",
              reason: "introspect the view's columns and underlying SELECT",
              args: { connection, database: r.db, view: only.table },
            },
            {
              tool: "get_view_ddl",
              reason: "get the CREATE VIEW DDL for this view",
              args: { connection, database: r.db, view: only.table },
            },
          ],
        });
      }
      const output = [
        "## Columns",
        formatAsTable(only.columns),
        "",
        "## Indexes",
        formatAsTable(only.indexes),
        "",
        "## Create Statement",
        "```sql",
        only.createStatement,
        "```",
      ].join("\n");
      return toolOk(output, {
        database: r.db,
        table: only.table,
        columns: only.columns,
        indexes: only.indexes,
        createStatement: only.createStatement,
      });
    }

    // ── multi-table array shape (new) ──────────────────────────────
    // Views in the set get a `isView: true` marker + an empty createStatement,
    // so the caller can detect mixed-input mistakes (asked for 3 tables, got
    // 2 tables + 1 view) without us failing the whole call.
    const sections: string[] = [];
    for (const res of results) {
      const header = res.isView
        ? `## \`${res.table}\` _(VIEW — use describe_view for the underlying SELECT)_`
        : `## \`${res.table}\``;
      sections.push(header);
      sections.push("");
      sections.push("### Columns");
      sections.push(formatAsTable(res.columns));
      if (!res.isView) {
        sections.push("");
        sections.push("### Indexes");
        sections.push(formatAsTable(res.indexes));
        sections.push("");
        sections.push("### Create Statement");
        sections.push("```sql");
        sections.push(res.createStatement);
        sections.push("```");
      }
      sections.push("");
    }
    return toolOk(sections.join("\n"), {
      database: r.db,
      results: results.map((res) => ({
        table: res.table,
        isView: res.isView,
        columns: res.columns,
        indexes: res.isView ? [] : res.indexes,
        createStatement: res.createStatement,
      })),
    });
  },
);

export const handleGetDdl = toolHandler(
  "get_ddl",
  async ({
    connection,
    table,
    tables: tablesArg,
    database,
  }: {
    connection: string;
    table?: string | undefined;
    tables?: string[] | undefined;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    // Same dual-shape split as describe_table: legacy `table` keeps
    // the flat response, new `tables` returns an array.
    const useArrayShape = !!tablesArg && tablesArg.length > 0;
    const filterSet = new Set<string>();
    if (table) filterSet.add(table);
    if (tablesArg) for (const t of tablesArg) filterSet.add(t);
    const targets = [...filterSet];

    if (targets.length === 0) {
      return toolError("get_ddl needs either `table` or `tables`.", {
        code: "GET_DDL_NO_TARGET",
        hint: 'Pass `table: "<name>"` for one or `tables: [...]` for a batch.',
        suggestions: [
          {
            tool: "list_tables",
            reason: "see what's available",
            args: { connection, database: r.db },
          },
        ],
      });
    }

    const ddls = await Promise.all(
      targets.map(async (t) => ({
        table: t,
        ddl: await getCreateTable(connection, r.db, t),
      })),
    );

    if (!useArrayShape) {
      const only = ddls[0];
      if (!only) {
        return toolError("get_ddl internal error: no result", {
          code: "INTERNAL_NO_RESULT",
        });
      }
      return toolOk(only.ddl, {
        database: r.db,
        table: only.table,
        ddl: only.ddl,
      });
    }

    // Concatenate with delimiters so the human-readable output stays
    // greppable per-table. The structured response keeps them
    // separate.
    const text = ddls
      .map(
        (d) =>
          `-- ── ${d.table} ──\n${d.ddl || "-- (no DDL — table missing or is a view)"}`,
      )
      .join("\n\n");
    return toolOk(text, {
      database: r.db,
      results: ddls,
    });
  },
);

export const handleGetForeignKeys = toolHandler(
  "get_foreign_keys",
  async ({
    connection,
    table,
    tables: tablesArg,
    database,
  }: {
    connection: string;
    table?: string | undefined;
    tables?: string[] | undefined;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    // Merge `table` and `tables` into a deduplicated filter — same
    // pattern as get_table_stats. Empty filter → every FK in the
    // database (the long-standing default).
    const filterSet = new Set<string>();
    if (table) filterSet.add(table);
    if (tablesArg) for (const t of tablesArg) filterSet.add(t);
    const filter = filterSet.size > 0 ? [...filterSet] : undefined;

    const fks = await getForeignKeys(connection, r.db, filter);

    if (fks.length === 0) {
      // Render the empty-state message based on what was asked for, so
      // "no FKs on these specific tables" reads differently from "no
      // FKs anywhere in the DB".
      const subject = filter
        ? filter.length === 1
          ? filter[0]
          : `${filter.length} tables`
        : r.db;
      return toolOk(
        filter ? `No foreign keys on ${subject}` : `No foreign keys in ${r.db}`,
        {
          database: r.db,
          tables: filter ?? null,
          foreignKeys: [],
        },
      );
    }

    const lines = fks.map(
      (fk) =>
        `${fk.TABLE_NAME}.${fk.COLUMN_NAME} -> ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME} (ON UPDATE ${fk.UPDATE_RULE}, ON DELETE ${fk.DELETE_RULE})`,
    );

    return toolOk(lines.join("\n") + `\n\n${fks.length} foreign key(s)`, {
      database: r.db,
      tables: filter ?? null,
      foreignKeys: fks,
    });
  },
);

export const handleGetIndexes = toolHandler(
  "get_indexes",
  async ({
    connection,
    table,
    tables: tablesArg,
    database,
  }: {
    connection: string;
    table?: string | undefined;
    tables?: string[] | undefined;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    // Same merge pattern as get_foreign_keys.
    const filterSet = new Set<string>();
    if (table) filterSet.add(table);
    if (tablesArg) for (const t of tablesArg) filterSet.add(t);
    const filter = filterSet.size > 0 ? [...filterSet] : undefined;

    const stats = await getIndexStats(connection, r.db, filter);
    if (stats.length === 0) {
      return toolOk("No indexes found", {
        database: r.db,
        indexes: [],
        duplicates: [],
      });
    }

    interface GroupedIndex {
      cols: string[];
      unique: boolean;
      type: string;
      cardinality: number | null;
    }
    const grouped = new Map<string, GroupedIndex>();
    for (const row of stats) {
      const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
      let entry = grouped.get(key);
      if (!entry) {
        entry = {
          cols: [],
          unique: row.NON_UNIQUE === 0,
          type: row.INDEX_TYPE,
          cardinality: row.CARDINALITY,
        };
        grouped.set(key, entry);
      }
      entry.cols.push(row.COLUMN_NAME);
    }

    const indexes = [...grouped.entries()].map(([key, info]) => {
      // Keys come from `${row.TABLE_NAME}.${row.INDEX_NAME}` above, so
      // the two-part split is guaranteed — the ?? guards are for the
      // type checker, not real data.
      const [tableName = "", name = ""] = key.split(".");
      return {
        table: tableName,
        name,
        unique: info.unique,
        type: info.type,
        columns: info.cols,
        cardinality: info.cardinality,
      };
    });

    const lines = indexes.map((idx) => {
      const uniqueTag = idx.unique ? "UNIQUE " : "";
      return `${idx.table}.${idx.name}: ${uniqueTag}${idx.type} (${idx.columns.join(", ")}) cardinality: ${idx.cardinality ?? "N/A"}`;
    });

    // Detect duplicates: indexes with same leading column(s) on same table
    const byTable = new Map<string, Array<{ name: string; cols: string[] }>>();
    for (const idx of indexes) {
      let bucket = byTable.get(idx.table);
      if (!bucket) {
        bucket = [];
        byTable.set(idx.table, bucket);
      }
      bucket.push({ name: idx.name, cols: idx.columns });
    }

    const duplicates: Array<{
      table: string;
      a: { name: string; columns: string[] };
      b: { name: string; columns: string[] };
    }> = [];
    const dupeLines: string[] = [];
    for (const [tbl, idxs] of byTable) {
      for (let i = 0; i < idxs.length; i++) {
        for (let j = i + 1; j < idxs.length; j++) {
          const a = idxs[i];
          const b = idxs[j];
          if (!a || !b) continue;
          const prefix = Math.min(a.cols.length, b.cols.length);
          const shared =
            a.cols.slice(0, prefix).join(",") ===
            b.cols.slice(0, prefix).join(",");
          if (shared) {
            duplicates.push({
              table: tbl,
              a: { name: a.name, columns: a.cols },
              b: { name: b.name, columns: b.cols },
            });
            dupeLines.push(
              `  ${tbl}: ${a.name}(${a.cols.join(",")}) overlaps with ${b.name}(${b.cols.join(",")})`,
            );
          }
        }
      }
    }

    let output = lines.join("\n") + `\n\n${indexes.length} index(es)`;
    if (dupeLines.length > 0) {
      output += `\n\n## Potential Duplicates\n${dupeLines.join("\n")}`;
    }

    return toolOk(output, { database: r.db, indexes, duplicates });
  },
);

export const handleSearchColumns = toolHandler(
  "search_columns",
  async ({
    connection,
    pattern,
    database,
  }: {
    connection: string;
    pattern: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const cols = await searchColumns(connection, r.db, pattern);
    if (cols.length === 0) {
      return toolOk(`No columns matching "${pattern}"`, {
        database: r.db,
        pattern,
        columns: [],
      });
    }

    return toolOk(
      formatAsTable(cols) +
        `\n\n${cols.length} column(s) matching "${pattern}"`,
      { database: r.db, pattern, columns: cols },
    );
  },
);

export const handleListViews = toolHandler(
  "list_views",
  async ({
    connection,
    database,
  }: {
    connection: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const views = await listViewsBrief(connection, r.db);
    if (views.length === 0) {
      return toolOk(`No views found in ${r.db}`, {
        database: r.db,
        views: [],
      });
    }

    return toolOk(
      formatAsTable(views) + `\n\n${views.length} view(s) in ${r.db}`,
      { database: r.db, views },
    );
  },
);

export const handleDescribeView = toolHandler(
  "describe_view",
  async ({
    connection,
    view,
    database,
  }: {
    connection: string;
    view: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const columns = await describeTableColumns(connection, r.db, view);
    const createStatement = await getViewDdl(connection, r.db, view);

    const output = [
      "## Columns",
      formatAsTable(columns),
      "",
      "## Create Statement",
      "```sql",
      createStatement,
      "```",
    ].join("\n");

    return toolOk(output, {
      database: r.db,
      view,
      columns,
      createStatement,
    });
  },
);

export const handleGetViewDdl = toolHandler(
  "get_view_ddl",
  async ({
    connection,
    view,
    database,
  }: {
    connection: string;
    view: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const ddl = await getViewDdl(connection, r.db, view);
    return toolOk(ddl, { database: r.db, view, ddl });
  },
);

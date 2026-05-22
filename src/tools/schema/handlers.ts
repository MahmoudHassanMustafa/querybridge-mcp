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

export const handleDescribeTable = toolHandler(
  "describe_table",
  async ({
    connection,
    table,
    database,
  }: {
    connection: string;
    table: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const columns = await describeTableColumns(connection, r.db, table);
    const createRow = await getCreateTableRaw(connection, r.db, table);
    if (createRow && !createRow["Create Table"] && createRow["Create View"]) {
      return toolError(
        `"${table}" is a view, not a table.`,
        "Use describe_view or get_view_ddl instead.",
      );
    }
    const createStatement = createRow?.["Create Table"] ?? "";
    const indexes = await showIndexes(connection, r.db, table);

    const output = [
      "## Columns",
      formatAsTable(columns),
      "",
      "## Indexes",
      formatAsTable(indexes),
      "",
      "## Create Statement",
      "```sql",
      createStatement,
      "```",
    ].join("\n");

    return toolOk(output, {
      database: r.db,
      table,
      columns,
      indexes,
      createStatement,
    });
  },
);

export const handleGetDdl = toolHandler(
  "get_ddl",
  async ({
    connection,
    table,
    database,
  }: {
    connection: string;
    table: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const ddl = await getCreateTable(connection, r.db, table);
    return toolOk(ddl, { database: r.db, table, ddl });
  },
);

export const handleGetForeignKeys = toolHandler(
  "get_foreign_keys",
  async ({
    connection,
    table,
    database,
  }: {
    connection: string;
    table?: string | undefined;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const fks = await getForeignKeys(connection, r.db, table);

    if (fks.length === 0) {
      return toolOk(
        table ? `No foreign keys on ${table}` : `No foreign keys in ${r.db}`,
        { database: r.db, table: table ?? null, foreignKeys: [] },
      );
    }

    const lines = fks.map(
      (fk) =>
        `${fk.TABLE_NAME}.${fk.COLUMN_NAME} -> ${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME} (ON UPDATE ${fk.UPDATE_RULE}, ON DELETE ${fk.DELETE_RULE})`,
    );

    return toolOk(lines.join("\n") + `\n\n${fks.length} foreign key(s)`, {
      database: r.db,
      table: table ?? null,
      foreignKeys: fks,
    });
  },
);

export const handleGetIndexes = toolHandler(
  "get_indexes",
  async ({
    connection,
    table,
    database,
  }: {
    connection: string;
    table?: string | undefined;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const stats = await getIndexStats(connection, r.db, table);
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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConnectionConfig, queryWithTimeout } from "../connection.js";
import { formatAsTable } from "../format.js";
import { resolveDb } from "../db/resolve.js";
import {
  getCharsetCollation,
  getProcessList,
  getUnusedIndexes,
} from "../db/introspection.js";
import {
  toolOk,
  toolHandler,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../tool-runtime.js";
import { ReadOnlyViolation } from "../errors.js";

// ── Handlers (exported for unit tests) ───────────────────────────

export const handleListProcesses = toolHandler(
  "list_processes",
  async ({
    connection,
    minSeconds,
  }: {
    connection: string;
    minSeconds?: number | undefined;
  }) => {
    const rows = await getProcessList(connection, minSeconds);

    if (rows.length === 0) {
      return toolOk("(no active processes)", { processes: [] });
    }

    return toolOk(
      formatAsTable(rows) + `\n\n${rows.length} active process(es)`,
      { processes: rows },
    );
  },
);

export const handleKillQuery = toolHandler(
  "kill_query",
  async ({
    connection,
    processId,
    killConnection,
  }: {
    connection: string;
    processId: number;
    killConnection?: boolean | undefined;
  }) => {
    const cfg = getConnectionConfig(connection);
    if (cfg.readonly !== false) {
      throw new ReadOnlyViolation(
        connection,
        `kill_query is blocked on read-only connection "${connection}".`,
      );
    }

    const variant = killConnection ? "CONNECTION" : "QUERY";
    // Process IDs come from MySQL itself; we still bound the value
    // (z.number().int().positive() validated) and Math.trunc it.
    // KILL does not accept ? placeholders so direct interpolation
    // is unavoidable.
    // eslint-disable-next-line no-restricted-syntax
    const killStatement = `KILL ${variant} ${Math.trunc(processId)}`;
    await queryWithTimeout(connection, killStatement);

    // User-facing confirmation message, not executed SQL — but
    // the lint rule's template-literal pattern matches anyway.
    const confirmation = "KILL " + variant + " " + processId + " issued.";
    return toolOk(confirmation, { processId, variant });
  },
);

export const handleGetUnusedIndexes = toolHandler(
  "get_unused_indexes",
  async ({
    connection,
    database,
  }: {
    connection: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const rows = await getUnusedIndexes(connection, r.db);

    if (rows.length === 0) {
      return toolOk(`No unused secondary indexes detected in ${r.db}.`, {
        database: r.db,
        unusedIndexes: [],
      });
    }

    const dropStatements = rows.map(
      // Suggestion text returned to the operator — never executed by this
      // server. Names come from information_schema and are quoted in
      // backticks for the operator's copy/paste convenience.
      // eslint-disable-next-line no-restricted-syntax
      (idx) => `ALTER TABLE \`${idx.database}\`.\`${idx.table}\` DROP INDEX \`${idx.index}\`;`,
    );

    const output =
      formatAsTable(rows) +
      `\n\n${rows.length} unused index(es) in ${r.db}\n\n## Suggested DROP statements\n` +
      dropStatements.join("\n") +
      "\n\nCaution: 'unused' = no reads since server start. Verify against your longest expected query cycle before dropping.";

    return toolOk(output, {
      database: r.db,
      unusedIndexes: rows,
      dropStatements,
    });
  },
);

export const handleGetCharsetCollation = toolHandler(
  "get_charset_collation",
  async ({
    connection,
    database,
    table,
  }: {
    connection: string;
    database?: string | undefined;
    table?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const info = await getCharsetCollation(connection, r.db, table);

    const sections: string[] = [
      "## Database",
      formatAsTable(info.databaseInfo),
    ];
    const structured: Record<string, unknown> = {
      database: r.db,
      databaseInfo: info.databaseInfo[0] ?? null,
    };

    if (table) {
      sections.push("\n## Table", formatAsTable(info.tableInfo));
      structured.tableInfo = info.tableInfo[0] ?? null;

      sections.push(
        "\n## Columns (string/text types only)",
        formatAsTable(info.columns),
      );
      structured.columns = info.columns;
    }

    return toolOk(sections.join("\n"), structured);
  },
);

// ── Tool registration ────────────────────────────────────────────

export function registerAdminTools(server: McpServer) {
  server.registerTool(
    "list_processes",
    {
      title: "List running processes",
      description:
        "Show the MySQL process list (running connections and their current queries). " +
        "Useful for spotting long-running queries before deciding to kill_query.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        minSeconds: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Only show processes running for at least this many seconds"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleListProcesses,
  );

  server.registerTool(
    "kill_query",
    {
      title: "Kill a running query",
      description:
        "Cancel a running query by its process ID. Use list_processes first to find the ID. " +
        "Gated: only available on connections configured with readonly: false.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        processId: z
          .number()
          .int()
          .positive()
          .describe("Process ID from list_processes (the ID column)"),
        killConnection: z
          .boolean()
          .optional()
          .describe(
            "true → KILL CONNECTION (terminates the whole session). " +
              "false (default) → KILL QUERY (only the running statement).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handleKillQuery,
  );

  server.registerTool(
    "get_unused_indexes",
    {
      title: "Find unused indexes",
      description:
        "List secondary indexes with zero read activity in performance_schema. " +
        "Primary keys are excluded. Requires performance_schema to be enabled " +
        "(default on MySQL 5.7+) and the server to have been running long enough " +
        "for usage stats to accumulate.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().optional().describe("Database name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetUnusedIndexes,
  );

  server.registerTool(
    "get_charset_collation",
    {
      title: "Get charset and collation",
      description:
        "Show character set and collation at the database, table, or column level. " +
        "Useful for diagnosing emoji-eating utf8mb3 columns or mixed collations that " +
        "cause 'Illegal mix of collations' errors in JOINs.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().optional().describe("Database name"),
        table: z
          .string()
          .optional()
          .describe("Table name (omit for database-level info)"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleGetCharsetCollation,
  );
}

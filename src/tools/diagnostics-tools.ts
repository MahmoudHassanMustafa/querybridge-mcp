/**
 * Operator-grade diagnostics tools.
 *
 *   - `server_info` — curated bird's-eye view (version, uptime,
 *     connection counts, key character set / SQL mode).
 *   - `show_variables` — system variable inspection with LIKE filter
 *     and GLOBAL / SESSION scope.
 *   - `show_status` — runtime counters with the same filter / scope.
 *   - `current_locks` — active lock waits and holders from
 *     `performance_schema.data_locks` + `data_lock_waits`.
 *   - `innodb_status` — raw `SHOW ENGINE INNODB STATUS` dump (latest
 *     deadlock, lock list, buffer pool stats).
 *   - `slow_queries` — top digests by total/avg/max time from
 *     `performance_schema.events_statements_summary_by_digest`.
 *
 * Why one file: each tool is small (~50 LOC handler) and they all hit
 * either SHOW-style commands or performance_schema directly. Grouping
 * them keeps the cross-references obvious and matches the
 * `admin-tools.ts` precedent.
 *
 * Privilege notes: `current_locks` and `slow_queries` need SELECT on
 * `performance_schema`. The default `testuser` in the integration
 * fixture doesn't have it by default; tests grant it explicitly. In
 * production this is normally already granted to monitoring users.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { queryWithTimeout } from "../connection.js";
import { raw, sql } from "../sql/template.js";
import {
  toolOk,
  toolHandler,
  READ_ONLY_TOOL_ANNOTATIONS,
} from "../tool-runtime.js";
import { formatAsTable } from "../format.js";

// ── server_info ────────────────────────────────────────────────────

interface ServerInfo {
  version: string;
  hostname: string | null;
  server_id: number | null;
  uptime_seconds: number | null;
  threads_connected: number | null;
  threads_running: number | null;
  max_connections: number | null;
  max_allowed_packet: number | null;
  character_set_server: string | null;
  collation_server: string | null;
  sql_mode: string | null;
  time_zone: string | null;
  read_only: number | null;
  super_read_only: number | null;
}

/**
 * Pull a curated bird's-eye snapshot of the server. The list of
 * variables / status counters is intentionally small — this is "what
 * does the operator want at a glance", not "every knob". For the full
 * inventory use `show_variables` / `show_status`.
 *
 * Implementation: one combined SELECT against `@@variable` and
 * `information_schema.GLOBAL_STATUS`-style sources. Falls back to
 * NULL for fields the server doesn't expose (older MySQL forks may
 * not have every variable).
 */
export const handleServerInfo = toolHandler(
  "server_info",
  async ({ connection }: { connection: string }) => {
    // One round-trip for every variable that's exposed via `@@`,
    // because SELECT @@x AS x is the cheapest way to read globals.
    // Run alongside a parallel SHOW STATUS for the uptime/threads
    // counters that aren't @@-accessible.
    const [versionRow, varsRow, statusRows] = await Promise.all([
      queryWithTimeout<Array<{ version: string }>>(
        connection,
        "SELECT VERSION() AS version",
      ),
      queryWithTimeout<Array<Record<string, string | number | null>>>(
        connection,
        `SELECT
            @@hostname AS hostname,
            @@server_id AS server_id,
            @@max_connections AS max_connections,
            @@max_allowed_packet AS max_allowed_packet,
            @@character_set_server AS character_set_server,
            @@collation_server AS collation_server,
            @@sql_mode AS sql_mode,
            @@time_zone AS time_zone,
            @@read_only AS read_only,
            @@super_read_only AS super_read_only`,
      ),
      queryWithTimeout<Array<{ Variable_name: string; Value: string }>>(
        connection,
        "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Threads_running')",
      ),
    ]);

    const status = new Map(statusRows.map((r) => [r.Variable_name, r.Value]));
    const vars = varsRow[0] ?? {};

    const info: ServerInfo = {
      version: versionRow[0]?.version ?? "unknown",
      hostname: vars["hostname"] as string | null,
      server_id: vars["server_id"] == null ? null : Number(vars["server_id"]),
      uptime_seconds:
        status.get("Uptime") == null ? null : Number(status.get("Uptime")),
      threads_connected:
        status.get("Threads_connected") == null
          ? null
          : Number(status.get("Threads_connected")),
      threads_running:
        status.get("Threads_running") == null
          ? null
          : Number(status.get("Threads_running")),
      max_connections:
        vars["max_connections"] == null
          ? null
          : Number(vars["max_connections"]),
      max_allowed_packet:
        vars["max_allowed_packet"] == null
          ? null
          : Number(vars["max_allowed_packet"]),
      character_set_server: vars["character_set_server"] as string | null,
      collation_server: vars["collation_server"] as string | null,
      sql_mode: vars["sql_mode"] as string | null,
      time_zone: vars["time_zone"] as string | null,
      read_only: vars["read_only"] == null ? null : Number(vars["read_only"]),
      super_read_only:
        vars["super_read_only"] == null
          ? null
          : Number(vars["super_read_only"]),
    };

    // Render compactly. The structured response carries everything;
    // the text body is for humans skimming the output.
    const formatBytes = (n: number | null): string =>
      n == null ? "n/a" : `${(n / (1024 * 1024)).toFixed(1)} MiB`;
    const formatUptime = (s: number | null): string => {
      if (s == null) return "n/a";
      const days = Math.floor(s / 86400);
      const hrs = Math.floor((s % 86400) / 3600);
      return `${days}d ${hrs}h`;
    };

    const text = [
      `Server:           ${info.version}`,
      `Hostname:         ${info.hostname ?? "n/a"}`,
      `Server ID:        ${info.server_id ?? "n/a"}`,
      `Uptime:           ${formatUptime(info.uptime_seconds)}`,
      `Threads:          ${info.threads_running ?? "n/a"} running / ${info.threads_connected ?? "n/a"} connected (max ${info.max_connections ?? "n/a"})`,
      `Max packet:       ${formatBytes(info.max_allowed_packet)}`,
      `Charset:          ${info.character_set_server ?? "n/a"} / ${info.collation_server ?? "n/a"}`,
      `Time zone:        ${info.time_zone ?? "n/a"}`,
      `Read-only:        ${info.read_only ? "yes" : "no"}${info.super_read_only ? " (super)" : ""}`,
      `SQL mode:         ${info.sql_mode ?? "n/a"}`,
    ].join("\n");

    return toolOk(text, info as unknown as Record<string, unknown>);
  },
);

// ── show_variables / show_status ───────────────────────────────────

type Scope = "GLOBAL" | "SESSION";

/**
 * SHOW VARIABLES / SHOW STATUS share the same shape: a name + value
 * with an optional LIKE filter and GLOBAL/SESSION scope. Keep the
 * implementation generic and dispatch based on the `kind` param so
 * we don't duplicate ~30 lines of handler.
 */
async function runShow(
  connection: string,
  kind: "VARIABLES" | "STATUS",
  pattern: string | undefined,
  scope: Scope,
): Promise<Array<{ Variable_name: string; Value: string }>> {
  // SHOW VARIABLES / SHOW STATUS doesn't accept `?` placeholders for
  // the GLOBAL/SESSION scope or the VARIABLES/STATUS keyword. The
  // LIKE pattern IS placeholder-safe — we bind it through the usual
  // params array. Using the `sql\`\`` tagged-template helper here
  // would gain no safety (every keyword is already a literal) and
  // trip the local SQL-template-interpolation lint rule.
  const hasPattern = !!pattern && pattern.length > 0;
  const stmt = (() => {
    if (kind === "VARIABLES") {
      if (hasPattern) {
        return scope === "GLOBAL"
          ? "SHOW GLOBAL VARIABLES LIKE ?"
          : "SHOW SESSION VARIABLES LIKE ?";
      }
      return scope === "GLOBAL"
        ? "SHOW GLOBAL VARIABLES"
        : "SHOW SESSION VARIABLES";
    }
    if (hasPattern) {
      return scope === "GLOBAL"
        ? "SHOW GLOBAL STATUS LIKE ?"
        : "SHOW SESSION STATUS LIKE ?";
    }
    return scope === "GLOBAL" ? "SHOW GLOBAL STATUS" : "SHOW SESSION STATUS";
  })();
  const params = hasPattern && pattern ? [pattern] : [];
  return queryWithTimeout(connection, stmt, params);
}

export const handleShowVariables = toolHandler(
  "show_variables",
  async ({
    connection,
    pattern,
    scope,
  }: {
    connection: string;
    pattern?: string | undefined;
    scope?: Scope | undefined;
  }) => {
    const rows = await runShow(
      connection,
      "VARIABLES",
      pattern,
      scope ?? "GLOBAL",
    );
    const text =
      rows.length === 0
        ? `No variables matching "${pattern ?? "*"}" in ${scope ?? "GLOBAL"} scope`
        : formatAsTable(rows) +
          `\n\n${rows.length} variable(s) in ${scope ?? "GLOBAL"} scope`;
    return toolOk(text, {
      scope: scope ?? "GLOBAL",
      pattern: pattern ?? null,
      variables: rows,
    });
  },
);

export const handleShowStatus = toolHandler(
  "show_status",
  async ({
    connection,
    pattern,
    scope,
  }: {
    connection: string;
    pattern?: string | undefined;
    scope?: Scope | undefined;
  }) => {
    const rows = await runShow(
      connection,
      "STATUS",
      pattern,
      scope ?? "GLOBAL",
    );
    const text =
      rows.length === 0
        ? `No status counters matching "${pattern ?? "*"}" in ${scope ?? "GLOBAL"} scope`
        : formatAsTable(rows) +
          `\n\n${rows.length} counter(s) in ${scope ?? "GLOBAL"} scope`;
    return toolOk(text, {
      scope: scope ?? "GLOBAL",
      pattern: pattern ?? null,
      counters: rows,
    });
  },
);

// ── current_locks ──────────────────────────────────────────────────

interface LockWaitRow {
  blocked_thread: number;
  blocked_query: string | null;
  blocking_thread: number;
  blocking_query: string | null;
  lock_type: string;
  lock_mode: string;
  object_schema: string | null;
  object_name: string | null;
  index_name: string | null;
  wait_started_seconds_ago: number | null;
}

export const handleCurrentLocks = toolHandler(
  "current_locks",
  async ({ connection }: { connection: string }) => {
    // performance_schema.data_lock_waits gives us blocker→blocked pairs
    // directly. Join to data_locks for lock type/mode, and to threads
    // + events_statements_current to surface the actual SQL each
    // thread is running.
    //
    // Read-only joined query; no filtering — operators want every
    // wait. If the list ever gets unmanageable on a busy server the
    // tool can grow a limit/timeout param later.
    const rows = await queryWithTimeout<LockWaitRow[]>(
      connection,
      `SELECT
        bt.PROCESSLIST_ID AS blocked_thread,
        be.SQL_TEXT AS blocked_query,
        rt.PROCESSLIST_ID AS blocking_thread,
        re.SQL_TEXT AS blocking_query,
        rl.LOCK_TYPE AS lock_type,
        rl.LOCK_MODE AS lock_mode,
        rl.OBJECT_SCHEMA AS object_schema,
        rl.OBJECT_NAME AS object_name,
        rl.INDEX_NAME AS index_name,
        TIMESTAMPDIFF(SECOND, be.TIMER_START / 1000000000000, NOW(6)) AS wait_started_seconds_ago
      FROM performance_schema.data_lock_waits w
      JOIN performance_schema.data_locks rl
        ON w.BLOCKING_ENGINE_LOCK_ID = rl.ENGINE_LOCK_ID
      JOIN performance_schema.threads bt
        ON bt.THREAD_ID = w.REQUESTING_THREAD_ID
      JOIN performance_schema.threads rt
        ON rt.THREAD_ID = w.BLOCKING_THREAD_ID
      LEFT JOIN performance_schema.events_statements_current be
        ON be.THREAD_ID = w.REQUESTING_THREAD_ID
      LEFT JOIN performance_schema.events_statements_current re
        ON re.THREAD_ID = w.BLOCKING_THREAD_ID
      ORDER BY wait_started_seconds_ago DESC`,
    );

    if (rows.length === 0) {
      return toolOk("No active lock waits.", { lock_waits: [] });
    }

    const lines = rows.map((r) => {
      const target =
        r.object_schema && r.object_name
          ? `${r.object_schema}.${r.object_name}${r.index_name ? `(${r.index_name})` : ""}`
          : "<unknown>";
      return [
        `Thread ${r.blocked_thread} blocked by thread ${r.blocking_thread}`,
        `  lock:       ${r.lock_type} ${r.lock_mode} on ${target}`,
        `  blocked:    ${r.blocked_query ?? "<idle>"}`,
        `  blocking:   ${r.blocking_query ?? "<idle>"}`,
        `  waiting:    ${r.wait_started_seconds_ago ?? "?"}s`,
      ].join("\n");
    });

    return toolOk(
      lines.join("\n\n") + `\n\n${rows.length} active lock wait(s)`,
      { lock_waits: rows },
    );
  },
);

// ── innodb_status ──────────────────────────────────────────────────

export const handleInnodbStatus = toolHandler(
  "innodb_status",
  async ({ connection }: { connection: string }) => {
    // SHOW ENGINE INNODB STATUS returns one row with three columns;
    // the human-readable dump lives in the third (`Status`).
    const rows = await queryWithTimeout<
      Array<{ Type: string; Name: string; Status: string }>
    >(connection, "SHOW ENGINE INNODB STATUS");

    const status = rows[0]?.Status ?? "";
    if (!status) {
      return toolOk("InnoDB returned an empty status dump.", {
        status_text: "",
        latest_deadlock: null,
      });
    }

    // Best-effort extract the "LATEST DETECTED DEADLOCK" section if
    // present. The header marker is stable across MySQL versions.
    const deadlockMatch = status.match(
      /LATEST DETECTED DEADLOCK\s*\n[-=]+\n([\s\S]+?)(?=\n[-=]{3,}\n[A-Z ]+\n[-=]{3,})/,
    );
    // group[1] is always defined when the overall regex matches —
    // it's the capture group inside the alternation — but TS can't
    // narrow that, so check before trim() rather than assert.
    const latestDeadlock = deadlockMatch?.[1]?.trim() ?? null;

    const summary = latestDeadlock
      ? `Status dump attached (${status.length} chars). Latest deadlock section also surfaced separately.`
      : `Status dump attached (${status.length} chars). No deadlock section present.`;

    // Wrap the raw text in a fenced block so MCP clients render it as
    // monospace and don't try to interpret the contents as markdown.
    const text = [summary, "", "```text", status, "```"].join("\n");

    return toolOk(text, {
      status_text: status,
      latest_deadlock: latestDeadlock,
    });
  },
);

// ── slow_queries ───────────────────────────────────────────────────

interface SlowQueryRow {
  schema_name: string | null;
  digest_text: string;
  count_star: number;
  sum_time_ms: number;
  avg_time_ms: number;
  max_time_ms: number;
  sum_rows_examined: number;
  avg_rows_examined: number;
  last_seen: string | null;
}

type SortBy = "total_time" | "avg_time" | "max_time" | "count";

export const handleSlowQueries = toolHandler(
  "slow_queries",
  async ({
    connection,
    limit,
    sort_by,
  }: {
    connection: string;
    limit?: number | undefined;
    sort_by?: SortBy | undefined;
  }) => {
    const n = Math.min(limit ?? 20, 100);
    const sortColumn = (() => {
      switch (sort_by ?? "total_time") {
        case "avg_time":
          return "AVG_TIMER_WAIT";
        case "max_time":
          return "MAX_TIMER_WAIT";
        case "count":
          return "COUNT_STAR";
        case "total_time":
        default:
          return "SUM_TIMER_WAIT";
      }
    })();

    // performance_schema timers are in picoseconds. Convert to ms in
    // the query so the tool result lands in a unit operators read at
    // a glance. The sort column is a TypeScript literal-union so the
    // template-literal interpolation is safe (each branch returns a
    // pre-known string), but we still go through `raw()` to satisfy
    // the SQL-template lint rule — except `raw()` only accepts
    // integers. So: four separate branches matching the column.
    //
    // (We can't `raw()` a string keyword; widening `raw` to accept
    // strings would defeat its safety guarantee. The branch-per-sort
    // pattern matches how `runShow` handles GLOBAL/SESSION.)
    const sortClause =
      sortColumn === "AVG_TIMER_WAIT"
        ? sql`ORDER BY AVG_TIMER_WAIT DESC`
        : sortColumn === "MAX_TIMER_WAIT"
          ? sql`ORDER BY MAX_TIMER_WAIT DESC`
          : sortColumn === "COUNT_STAR"
            ? sql`ORDER BY COUNT_STAR DESC`
            : sql`ORDER BY SUM_TIMER_WAIT DESC`;

    // Build the full SELECT from a literal head + the sort fragment
    // + LIMIT. Picoseconds → ms = / 1e9.
    const head = `SELECT
        SCHEMA_NAME AS schema_name,
        DIGEST_TEXT AS digest_text,
        COUNT_STAR AS count_star,
        SUM_TIMER_WAIT / 1e9 AS sum_time_ms,
        AVG_TIMER_WAIT / 1e9 AS avg_time_ms,
        MAX_TIMER_WAIT / 1e9 AS max_time_ms,
        SUM_ROWS_EXAMINED AS sum_rows_examined,
        ROUND(SUM_ROWS_EXAMINED / NULLIF(COUNT_STAR, 0)) AS avg_rows_examined,
        LAST_SEEN AS last_seen
      FROM performance_schema.events_statements_summary_by_digest
      WHERE DIGEST_TEXT IS NOT NULL`;
    const fullSql = `${head} ${sortClause.sql} LIMIT ${raw(n).value}`;

    const rows = await queryWithTimeout<SlowQueryRow[]>(connection, fullSql);

    if (rows.length === 0) {
      return toolOk("No slow-query digests recorded in performance_schema.", {
        sort_by: sort_by ?? "total_time",
        queries: [],
      });
    }

    // Compact rendered form — full digest text lives in
    // structuredContent so the agent can inspect long queries.
    const formatted = rows.map((r) => ({
      schema: r.schema_name ?? "n/a",
      count: r.count_star,
      total_ms: Number(r.sum_time_ms).toFixed(1),
      avg_ms: Number(r.avg_time_ms).toFixed(1),
      max_ms: Number(r.max_time_ms).toFixed(1),
      avg_rows: r.avg_rows_examined,
      digest:
        r.digest_text.length > 80
          ? r.digest_text.slice(0, 77) + "..."
          : r.digest_text,
    }));

    return toolOk(
      formatAsTable(formatted) +
        `\n\n${rows.length} digest(s), sorted by ${sort_by ?? "total_time"}`,
      {
        sort_by: sort_by ?? "total_time",
        queries: rows,
      },
    );
  },
);

// ── registration ───────────────────────────────────────────────────

export function registerDiagnosticsTools(server: McpServer) {
  server.registerTool(
    "server_info",
    {
      title: "MySQL server info snapshot",
      description:
        "Bird's-eye view of the server: version, hostname, uptime, thread counts, " +
        "key charset / SQL mode / time zone. One round-trip, ~15 curated fields. " +
        "For the full inventory use `show_variables` / `show_status`.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleServerInfo,
  );

  server.registerTool(
    "show_variables",
    {
      title: "SHOW VARIABLES with LIKE filter",
      description:
        "List system variables. Optional `pattern` (SQL LIKE — e.g. `%timeout%`) and " +
        "`scope` (GLOBAL or SESSION; default GLOBAL).",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        pattern: z
          .string()
          .optional()
          .describe(
            "LIKE pattern (e.g. `%timeout%`). Omit to list all variables.",
          ),
        scope: z
          .enum(["GLOBAL", "SESSION"])
          .optional()
          .describe("Variable scope. Default GLOBAL."),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleShowVariables,
  );

  server.registerTool(
    "show_status",
    {
      title: "SHOW STATUS with LIKE filter",
      description:
        "List runtime status counters. Same shape as show_variables but for " +
        "monotonically-increasing counters and session/global state " +
        "(connections, bytes sent/received, slow query count, etc.).",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        pattern: z
          .string()
          .optional()
          .describe(
            "LIKE pattern (e.g. `Threads_%`). Omit to list all counters.",
          ),
        scope: z
          .enum(["GLOBAL", "SESSION"])
          .optional()
          .describe("Counter scope. Default GLOBAL."),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleShowStatus,
  );

  server.registerTool(
    "current_locks",
    {
      title: "Active InnoDB lock waits",
      description:
        "List rows from `performance_schema.data_lock_waits` joined to thread + " +
        "statement info — surfaces every active blocker→blocked pair on the " +
        "server with the SQL each thread is running. Requires SELECT on " +
        "performance_schema.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleCurrentLocks,
  );

  server.registerTool(
    "innodb_status",
    {
      title: "SHOW ENGINE INNODB STATUS",
      description:
        "Raw `SHOW ENGINE INNODB STATUS` dump. Long-form transaction list, " +
        "buffer-pool stats, log-sequence numbers, and (when present) the " +
        "latest detected deadlock. The deadlock section is also surfaced " +
        "separately in structuredContent for easy parsing.",
      inputSchema: {
        connection: z.string().describe("Connection name"),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleInnodbStatus,
  );

  server.registerTool(
    "slow_queries",
    {
      title: "Top slow queries from performance_schema",
      description:
        "Top query digests from `performance_schema.events_statements_summary_by_digest`. " +
        "Reports count, total / avg / max time in milliseconds, and rows examined per " +
        "digest. Default sort is total time (worst aggregate offenders).",
      inputSchema: {
        connection: z.string().describe("Connection name"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of digests to return. Default 20, max 100."),
        sort_by: z
          .enum(["total_time", "avg_time", "max_time", "count"])
          .optional()
          .describe(
            "Sort key: total_time (default — biggest aggregate impact), " +
              "avg_time (worst typical case), max_time (worst single execution), " +
              "or count (most frequent).",
          ),
      },
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    handleSlowQueries,
  );
}

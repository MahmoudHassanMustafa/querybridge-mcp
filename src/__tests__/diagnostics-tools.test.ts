import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetConnectionsForTests,
  registerMockConnection,
} from "../connection.js";
import { MockRunner } from "./utils/mock-runner.js";
import {
  handleServerInfo,
  handleShowVariables,
  handleShowStatus,
  handleCurrentLocks,
  handleInnodbStatus,
  handleSlowQueries,
} from "../tools/diagnostics-tools.js";

// Unit coverage focuses on:
//   1. The SQL each handler emits (scope/keyword branches especially).
//   2. The response shape (structuredContent fields, text formatting).
//   3. Edge cases — empty results, missing variables, no deadlock.
//
// End-to-end behaviour against real MySQL — privilege requirements,
// performance_schema availability — lives in the integration suite.

const CONN = "mock";

beforeEach(() => {
  __resetConnectionsForTests();
});

// ── server_info ────────────────────────────────────────────────

describe("server_info", () => {
  it("combines VERSION(), @@variables, and SHOW STATUS into one structured snapshot", async () => {
    const runner = new MockRunner()
      .whenSql(/SELECT VERSION\(\)/i, [{ version: "8.4.0" }])
      .whenSql(/SELECT[\s\S]*@@hostname/i, [
        {
          hostname: "db-01",
          server_id: 7,
          max_connections: 200,
          max_allowed_packet: 67108864,
          character_set_server: "utf8mb4",
          collation_server: "utf8mb4_0900_ai_ci",
          sql_mode: "STRICT_TRANS_TABLES",
          time_zone: "+00:00",
          read_only: 0,
          super_read_only: 0,
        },
      ])
      .whenSql(/SHOW GLOBAL STATUS WHERE/i, [
        { Variable_name: "Uptime", Value: "123456" },
        { Variable_name: "Threads_connected", Value: "12" },
        { Variable_name: "Threads_running", Value: "3" },
      ]);
    registerMockConnection(CONN, runner);

    const r = await handleServerInfo({ connection: CONN });
    expect("isError" in r && r.isError).toBeFalsy();

    const sc = (r as { structuredContent: Record<string, unknown> })
      .structuredContent;
    expect(sc.version).toBe("8.4.0");
    expect(sc.hostname).toBe("db-01");
    expect(sc.uptime_seconds).toBe(123456);
    expect(sc.threads_connected).toBe(12);
    expect(sc.threads_running).toBe(3);
    expect(sc.max_connections).toBe(200);
    expect(sc.character_set_server).toBe("utf8mb4");
    // text formatting — operator-skimmable
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).toContain("Server:           8.4.0");
    expect(text).toContain("Hostname:         db-01");
    expect(text).toContain(
      "Threads:          3 running / 12 connected (max 200)",
    );
  });

  it("renders 'n/a' for variables the server doesn't expose", async () => {
    const runner = new MockRunner()
      .whenSql(/SELECT VERSION\(\)/i, [{ version: "5.7.0" }])
      .whenSql(/SELECT[\s\S]*@@hostname/i, [
        {
          hostname: null,
          server_id: null,
          max_connections: null,
          max_allowed_packet: null,
          character_set_server: null,
          collation_server: null,
          sql_mode: null,
          time_zone: null,
          read_only: null,
          super_read_only: null,
        },
      ])
      .whenSql(/SHOW GLOBAL STATUS WHERE/i, []);
    registerMockConnection(CONN, runner);

    const r = await handleServerInfo({ connection: CONN });
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).toContain("Hostname:         n/a");
    expect(text).toContain("Uptime:           n/a");
  });
});

// ── show_variables ─────────────────────────────────────────────

describe("show_variables", () => {
  it("emits SHOW GLOBAL VARIABLES with no LIKE when no pattern given", async () => {
    const runner = new MockRunner().whenSql(/SHOW GLOBAL VARIABLES/i, []);
    registerMockConnection(CONN, runner);
    await handleShowVariables({ connection: CONN });
    const call = runner.calls()[0]!;
    expect(call.sql).toBe("SHOW GLOBAL VARIABLES");
    expect(call.params).toEqual([]);
  });

  it("binds the LIKE pattern as a placeholder, never inlines it", async () => {
    const runner = new MockRunner().whenSql(/SHOW GLOBAL VARIABLES LIKE/i, []);
    registerMockConnection(CONN, runner);
    await handleShowVariables({ connection: CONN, pattern: "%timeout%" });
    const call = runner.calls()[0]!;
    expect(call.sql).toBe("SHOW GLOBAL VARIABLES LIKE ?");
    expect(call.params).toEqual(["%timeout%"]);
  });

  it("switches keyword on scope=SESSION", async () => {
    const runner = new MockRunner().whenSql(/SHOW SESSION VARIABLES LIKE/i, []);
    registerMockConnection(CONN, runner);
    await handleShowVariables({
      connection: CONN,
      pattern: "tx_%",
      scope: "SESSION",
    });
    const call = runner.calls()[0]!;
    expect(call.sql).toBe("SHOW SESSION VARIABLES LIKE ?");
    expect(call.params).toEqual(["tx_%"]);
  });

  it("renders an empty-state message when no rows match", async () => {
    registerMockConnection(
      CONN,
      new MockRunner().whenSql(/SHOW GLOBAL VARIABLES LIKE/i, []),
    );
    const r = await handleShowVariables({
      connection: CONN,
      pattern: "%ghost%",
    });
    expect(
      (r as { content: Array<{ text: string }> }).content[0]?.text,
    ).toContain(`No variables matching "%ghost%"`);
  });
});

// ── show_status ────────────────────────────────────────────────

describe("show_status", () => {
  it("emits SHOW GLOBAL STATUS without LIKE by default", async () => {
    const runner = new MockRunner().whenSql(/SHOW GLOBAL STATUS/i, [
      { Variable_name: "Uptime", Value: "100" },
    ]);
    registerMockConnection(CONN, runner);
    const r = await handleShowStatus({ connection: CONN });
    const call = runner.calls()[0]!;
    expect(call.sql).toBe("SHOW GLOBAL STATUS");
    expect(call.params).toEqual([]);
    expect(
      (r as { structuredContent: { counters: unknown[] } }).structuredContent
        .counters,
    ).toHaveLength(1);
  });

  it("filters with LIKE pattern in GLOBAL scope", async () => {
    const runner = new MockRunner().whenSql(/SHOW GLOBAL STATUS LIKE/i, [
      { Variable_name: "Threads_running", Value: "5" },
    ]);
    registerMockConnection(CONN, runner);
    await handleShowStatus({ connection: CONN, pattern: "Threads_%" });
    const call = runner.calls()[0]!;
    expect(call.sql).toBe("SHOW GLOBAL STATUS LIKE ?");
    expect(call.params).toEqual(["Threads_%"]);
  });

  it("supports SESSION scope", async () => {
    const runner = new MockRunner().whenSql(/SHOW SESSION STATUS/i, []);
    registerMockConnection(CONN, runner);
    await handleShowStatus({ connection: CONN, scope: "SESSION" });
    expect(runner.calls()[0]?.sql).toBe("SHOW SESSION STATUS");
  });
});

// ── current_locks ──────────────────────────────────────────────

describe("current_locks", () => {
  it("returns 'No active lock waits.' when performance_schema is empty", async () => {
    registerMockConnection(
      CONN,
      new MockRunner().whenSql(/performance_schema\.data_lock_waits/, []),
    );
    const r = await handleCurrentLocks({ connection: CONN });
    expect((r as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "No active lock waits.",
    );
    expect(
      (r as { structuredContent: { lock_waits: unknown[] } }).structuredContent
        .lock_waits,
    ).toEqual([]);
  });

  it("renders blocker → blocked pairs with SQL and lock info", async () => {
    const runner = new MockRunner().whenSql(
      /performance_schema\.data_lock_waits/,
      [
        {
          blocked_thread: 42,
          blocked_query: "UPDATE users SET email = ? WHERE id = ?",
          blocking_thread: 17,
          blocking_query: "UPDATE users SET status = ? WHERE id = ?",
          lock_type: "RECORD",
          lock_mode: "X",
          object_schema: "shop",
          object_name: "users",
          index_name: "PRIMARY",
          wait_started_seconds_ago: 12,
        },
      ],
    );
    registerMockConnection(CONN, runner);
    const r = await handleCurrentLocks({ connection: CONN });
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).toContain("Thread 42 blocked by thread 17");
    expect(text).toContain("shop.users(PRIMARY)");
    expect(text).toContain("UPDATE users SET email = ? WHERE id = ?");
    expect(text).toContain("waiting:    12s");
  });
});

// ── innodb_status ──────────────────────────────────────────────

describe("innodb_status", () => {
  it("returns the raw status text in a fenced code block", async () => {
    const dump = "TRANSACTIONS\n------------\nTrx id 1234\nstuff happening";
    registerMockConnection(
      CONN,
      new MockRunner().whenSql(/SHOW ENGINE INNODB STATUS/i, [
        { Type: "InnoDB", Name: "", Status: dump },
      ]),
    );
    const r = await handleInnodbStatus({ connection: CONN });
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).toContain("```text");
    expect(text).toContain(dump);
    expect(text).toContain("```");
    expect((r.structuredContent as { status_text: string }).status_text).toBe(
      dump,
    );
    expect(
      (r.structuredContent as { latest_deadlock: string | null })
        .latest_deadlock,
    ).toBeNull();
  });

  it("extracts the LATEST DETECTED DEADLOCK section when present", async () => {
    // Realistic-shaped dump — header + deadlock section + trailing
    // section so the regex's lookahead has something to anchor on.
    const deadlockBody =
      "*** (1) TRANSACTION:\nTRANSACTION 100, ACTIVE 1 sec\n*** WE ROLL BACK TRANSACTION (1)";
    const dump = [
      "===========",
      "BACKGROUND THREAD",
      "===========",
      "stuff",
      "",
      "LATEST DETECTED DEADLOCK",
      "------------------------",
      deadlockBody,
      "",
      "------------",
      "TRANSACTIONS",
      "------------",
      "(other stuff)",
    ].join("\n");
    registerMockConnection(
      CONN,
      new MockRunner().whenSql(/SHOW ENGINE INNODB STATUS/i, [
        { Type: "InnoDB", Name: "", Status: dump },
      ]),
    );
    const r = await handleInnodbStatus({ connection: CONN });
    const sc = r.structuredContent as {
      status_text: string;
      latest_deadlock: string | null;
    };
    expect(sc.latest_deadlock).toContain("*** (1) TRANSACTION:");
    expect(sc.latest_deadlock).toContain("WE ROLL BACK TRANSACTION");
  });

  it("returns an empty-text message when the dump is missing", async () => {
    registerMockConnection(
      CONN,
      new MockRunner().whenSql(/SHOW ENGINE INNODB STATUS/i, []),
    );
    const r = await handleInnodbStatus({ connection: CONN });
    expect(
      (r as { content: Array<{ text: string }> }).content[0]?.text,
    ).toContain("empty status dump");
  });
});

// ── slow_queries ───────────────────────────────────────────────

describe("slow_queries", () => {
  it("defaults to sort_by=total_time and converts picoseconds to ms", async () => {
    const runner = new MockRunner().whenSql(
      /events_statements_summary_by_digest/,
      [
        {
          schema_name: "shop",
          digest_text: "SELECT * FROM users",
          count_star: 100,
          sum_time_ms: 5000,
          avg_time_ms: 50,
          max_time_ms: 200,
          sum_rows_examined: 100000,
          avg_rows_examined: 1000,
          last_seen: "2026-05-23 13:00:00",
        },
      ],
    );
    registerMockConnection(CONN, runner);
    const r = await handleSlowQueries({ connection: CONN });
    const call = runner.calls()[0]!;
    // default sort: total_time → SUM_TIMER_WAIT
    expect(call.sql).toContain("ORDER BY SUM_TIMER_WAIT DESC");
    // default limit 20
    expect(call.sql).toContain("LIMIT 20");
    // ms conversion happened in the SELECT projection
    expect(call.sql).toContain("SUM_TIMER_WAIT / 1e9 AS sum_time_ms");
    expect((r.structuredContent as { sort_by: string }).sort_by).toBe(
      "total_time",
    );
  });

  it("each sort_by option emits the matching ORDER BY clause", async () => {
    const cases: Array<{
      sort: "avg_time" | "max_time" | "count";
      col: string;
    }> = [
      { sort: "avg_time", col: "AVG_TIMER_WAIT" },
      { sort: "max_time", col: "MAX_TIMER_WAIT" },
      { sort: "count", col: "COUNT_STAR" },
    ];
    for (const c of cases) {
      __resetConnectionsForTests();
      const runner = new MockRunner().whenSql(
        /events_statements_summary_by_digest/,
        [],
      );
      registerMockConnection(CONN, runner);
      await handleSlowQueries({ connection: CONN, sort_by: c.sort });
      expect(runner.calls()[0]?.sql).toContain(`ORDER BY ${c.col} DESC`);
    }
  });

  it("caps `limit` at 100 even if the caller asks for more", async () => {
    const runner = new MockRunner().whenSql(
      /events_statements_summary_by_digest/,
      [],
    );
    registerMockConnection(CONN, runner);
    await handleSlowQueries({ connection: CONN, limit: 9999 });
    expect(runner.calls()[0]?.sql).toContain("LIMIT 100");
  });

  it("returns the empty-state message when nothing is recorded", async () => {
    registerMockConnection(
      CONN,
      new MockRunner().whenSql(/events_statements_summary_by_digest/, []),
    );
    const r = await handleSlowQueries({ connection: CONN });
    expect(
      (r as { content: Array<{ text: string }> }).content[0]?.text,
    ).toContain("No slow-query digests recorded");
  });
});

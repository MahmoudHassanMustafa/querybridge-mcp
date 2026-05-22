import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetConnectionsForTests,
  registerMockConnection,
} from "../connection.js";
import {
  ConnectionNotFound,
  DatabaseNotResolved,
  MalformedExplainOutput,
  ReadOnlyViolation,
} from "../errors.js";
import { toolError, toolHandler } from "../tool-runtime.js";
import { MockRunner } from "./utils/mock-runner.js";
import { handleUseDatabase } from "../tools/connection-tools.js";
import { handleDescribeTable } from "../tools/schema/handlers.js";

// ── toolError shape ─────────────────────────────────────────────

describe("toolError — legacy hint-only call (regression guard)", () => {
  it("still produces the same shape it always did when called with a string hint", () => {
    const r = toolError("X not found", "Try Y.");
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe("X not found\nHint: Try Y.");
    // No structured content when neither code nor suggestions are passed —
    // saves wire bytes for clients that don't render it.
    expect(r.structuredContent).toBeUndefined();
  });

  it("works with just a message and no hint", () => {
    const r = toolError("nothing here");
    expect(r.content[0]?.text).toBe("nothing here");
    expect(r.structuredContent).toBeUndefined();
  });
});

describe("toolError — structured options form", () => {
  it("renders suggestions as bullets AND attaches them to structuredContent", () => {
    const r = toolError("Table 'foo' not found", {
      hint: "Use list_tables to enumerate visible tables.",
      code: "TABLE_NOT_FOUND",
      suggestions: [
        {
          tool: "list_tables",
          reason: "see every table in the active database",
          args: { connection: "prod", database: "shop" },
        },
        {
          tool: "search_columns",
          reason: "find tables by column name pattern",
        },
      ],
    });

    expect(r.isError).toBe(true);
    const text = r.content[0]?.text ?? "";
    expect(text).toContain("Hint: Use list_tables");
    expect(text).toContain("Try one of these tools next:");
    // Suggestion with args renders the args JSON inline so the agent
    // sees a copy-pasteable invocation.
    expect(text).toContain(
      `  - list_tables — see every table in the active database (args: {"connection":"prod","database":"shop"})`,
    );
    // Suggestion without args omits the trailing parens — they would be
    // empty noise otherwise.
    expect(text).toContain(
      `  - search_columns — find tables by column name pattern\n`.trimEnd() ??
        "",
    );

    expect(r.structuredContent).toEqual({
      code: "TABLE_NOT_FOUND",
      suggestions: [
        {
          tool: "list_tables",
          reason: "see every table in the active database",
          args: { connection: "prod", database: "shop" },
        },
        {
          tool: "search_columns",
          reason: "find tables by column name pattern",
        },
      ],
    });
  });

  it("treats an empty args object as 'no args' (no parens in text)", () => {
    const r = toolError("nope", {
      suggestions: [{ tool: "list_connections", reason: "see what's there", args: {} }],
    });
    expect(r.content[0]?.text).toContain("- list_connections — see what's there");
    expect(r.content[0]?.text).not.toContain("args: {}");
  });

  it("emits code-only structuredContent when there are no suggestions", () => {
    const r = toolError("X", { code: "X_FAILED" });
    expect(r.structuredContent).toEqual({ code: "X_FAILED" });
  });

  it("skips structuredContent entirely when only hint is provided", () => {
    const r = toolError("X", { hint: "do Y" });
    expect(r.structuredContent).toBeUndefined();
  });
});

// ── QueryBridgeError → toolError forwarding via toolHandler ─────

describe("toolHandler forwards QueryBridgeError suggestions", () => {
  it("ConnectionNotFound surfaces list_connections suggestion + code", async () => {
    const handler = toolHandler<{ connection: string }>(
      "test-tool",
      async () => {
        throw new ConnectionNotFound("ghost");
      },
    );
    const r = await handler({ connection: "ghost" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "CONNECTION_NOT_FOUND",
      suggestions: [
        {
          tool: "list_connections",
          reason: "enumerate the connections that are actually registered",
        },
      ],
    });
    expect(r.content[0]?.text).toContain("list_connections");
  });

  it("ReadOnlyViolation forwards its suggestions", async () => {
    const handler = toolHandler<{ connection: string }>(
      "test-tool",
      async () => {
        throw new ReadOnlyViolation("prod");
      },
    );
    const r = await handler({ connection: "prod" });
    expect(
      (r.structuredContent as { code: string }).code,
    ).toBe("READ_ONLY_VIOLATION");
    expect(
      (r.structuredContent as { suggestions: Array<{ tool: string }> })
        .suggestions[0]?.tool,
    ).toBe("list_connections");
  });

  it("DatabaseNotResolved surfaces both list_databases and use_database", async () => {
    const handler = toolHandler<Record<string, unknown>>(
      "test-tool",
      async () => {
        throw new DatabaseNotResolved();
      },
    );
    const r = await handler({});
    const tools = (
      r.structuredContent as {
        suggestions: Array<{ tool: string }>;
      }
    ).suggestions.map((s) => s.tool);
    expect(tools).toEqual(["list_databases", "use_database"]);
  });

  it("MalformedExplainOutput pre-fills format=TRADITIONAL on its suggestion", async () => {
    const handler = toolHandler<Record<string, unknown>>(
      "test-tool",
      async () => {
        throw new MalformedExplainOutput("unexpected token");
      },
    );
    const r = await handler({});
    const sc = r.structuredContent as {
      suggestions: Array<{ tool: string; args?: Record<string, unknown> }>;
    };
    expect(sc.suggestions[0]?.tool).toBe("explain_query");
    expect(sc.suggestions[0]?.args).toEqual({ format: "TRADITIONAL" });
  });
});

// ── Real tools wire pre-filled args into suggestions ───────────

describe("real tools emit suggestions with pre-filled connection context", () => {
  beforeEach(() => {
    __resetConnectionsForTests();
  });

  it("use_database against an unknown DB suggests list_databases with the connection arg pre-filled", async () => {
    const runner = new MockRunner().whenSql(/SHOW DATABASES LIKE/, []);
    registerMockConnection("c1", runner);

    const r = await handleUseDatabase({
      connection: "c1",
      database: "ghost-db",
    });
    expect(r.isError).toBe(true);
    const sc = r.structuredContent as {
      code: string;
      suggestions: Array<{ tool: string; args: Record<string, unknown> }>;
    };
    expect(sc.code).toBe("DATABASE_NOT_FOUND");
    expect(sc.suggestions[0]).toEqual({
      tool: "list_databases",
      reason: "enumerate databases visible on this connection",
      args: { connection: "c1" },
    });
  });

  it("describe_table on a view points the agent at describe_view + get_view_ddl with the same identifiers", async () => {
    // The handler runs `describeTableColumns`, then `getCreateTableRaw`. We
    // make the columns query return an empty array (real MySQL also returns
    // empty for a view used as a table here), and the create-table query
    // return a view-shaped row.
    const runner = new MockRunner()
      .whenSql(/^DESCRIBE /s, [])
      .whenSql(/^SHOW CREATE TABLE/s, [
        { View: "v_users", "Create View": "CREATE VIEW v_users AS SELECT ..." },
      ]);
    registerMockConnection("c1", runner, { database: "shop" });

    const r = await handleDescribeTable({
      connection: "c1",
      table: "v_users",
    });
    expect(r.isError).toBe(true);
    const sc = r.structuredContent as {
      code: string;
      suggestions: Array<{ tool: string; args: Record<string, unknown> }>;
    };
    expect(sc.code).toBe("OBJECT_IS_VIEW");
    const tools = sc.suggestions.map((s) => s.tool);
    expect(tools).toEqual(["describe_view", "get_view_ddl"]);
    // Both suggestions pre-fill the same {connection, database, view}
    // triple so the agent's next call is one tool invocation away.
    for (const s of sc.suggestions) {
      expect(s.args).toEqual({
        connection: "c1",
        database: "shop",
        view: "v_users",
      });
    }
  });
});

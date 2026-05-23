import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetConnectionsForTests,
  registerMockConnection,
} from "../connection.js";
import { MockRunner } from "./utils/mock-runner.js";
import { handleTraverseFk } from "../tools/traverse-tools.js";

// Mock-runner coverage focuses on the BFS logic, the cycle-detection
// keying, and the error paths. End-to-end FK navigation against real
// MySQL is covered in the integration suite (users/orders seeded
// schema gives us a realistic two-table graph).

const CONN = "mock";
const DB = "shop";

beforeEach(() => {
  __resetConnectionsForTests();
});

// ── pre-flight error paths ────────────────────────────────────────

describe("traverse_fk — pre-flight errors", () => {
  it("returns COMPOSITE_PK_NOT_SUPPORTED when the starting table has no single-col PK", async () => {
    // PK query returns 2 columns → composite PK.
    const runner = new MockRunner().whenSql(
      /KEY_COLUMN_USAGE[\s\S]*CONSTRAINT_NAME = 'PRIMARY'/,
      [{ COLUMN_NAME: "user_id" }, { COLUMN_NAME: "role_id" }],
    );
    registerMockConnection(CONN, runner, { database: DB });
    const r = await handleTraverseFk({
      connection: CONN,
      table: "user_roles",
      primary_key_value: 1,
    });
    expect("isError" in r && r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe(
      "COMPOSITE_PK_NOT_SUPPORTED",
    );
    // Suggestion should point at describe_table to inspect the PK shape.
    const suggestions = (
      r.structuredContent as {
        suggestions: Array<{ tool: string; args: Record<string, unknown> }>;
      }
    ).suggestions;
    expect(suggestions[0]?.tool).toBe("describe_table");
    expect(suggestions[0]?.args).toEqual({
      connection: CONN,
      database: DB,
      table: "user_roles",
    });
  });

  it("returns SEED_ROW_NOT_FOUND when the seed PK doesn't match any row", async () => {
    const runner = new MockRunner()
      .whenSql(/KEY_COLUMN_USAGE[\s\S]*CONSTRAINT_NAME = 'PRIMARY'/, [
        { COLUMN_NAME: "id" },
      ])
      .whenSql(/SELECT \* FROM `shop`\.`users` WHERE `id` = \?/, []);
    registerMockConnection(CONN, runner, { database: DB });
    const r = await handleTraverseFk({
      connection: CONN,
      table: "users",
      primary_key_value: 99999,
    });
    expect("isError" in r && r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe(
      "SEED_ROW_NOT_FOUND",
    );
    // sample_data is the suggested follow-up — pre-fills connection/db/table.
    const suggestions = (
      r.structuredContent as {
        suggestions: Array<{ tool: string; args: Record<string, unknown> }>;
      }
    ).suggestions;
    expect(suggestions[0]?.tool).toBe("sample_data");
  });
});

// ── BFS happy path ────────────────────────────────────────────────

describe("traverse_fk — single hop both directions", () => {
  /**
   * Schema fixture for the BFS tests:
   *   - users (id)
   *   - orders (id, user_id → users.id)
   * Seed: orders.id = 42, which references users.id = 7.
   * Expected at depth=1, direction=both:
   *   - seed node (orders#42)
   *   - parent node (users#7) via orders.user_id → users.id
   *   - children of users#7 via FK orders.user_id → users.id (could include orders#42 again — cycle-detected)
   */
  function fixtureRunner() {
    return (
      new MockRunner()
        // PK lookup for orders
        .whenSql(
          /KEY_COLUMN_USAGE[\s\S]*'PRIMARY'[\s\S]*TABLE_NAME = \?/,
          // Inspected at call-time below — fall through to per-table
          // patterns instead.
          [],
        )
        // Fallthrough: more specific patterns first
        .whenSql(
          // ad-hoc per-table PK responses — match by params via the
          // SQL since MockRunner doesn't expose param-based dispatch
          /KEY_COLUMN_USAGE[\s\S]*CONSTRAINT_NAME = 'PRIMARY'/,
          [{ COLUMN_NAME: "id" }],
        )
        // Seed-row fetch
        .whenSql(/SELECT \* FROM `shop`\.`orders` WHERE `id` = \?/, [
          { id: 42, user_id: 7, total: 99.99 },
        ])
        // Parent-row fetch (users)
        .whenSql(/SELECT \* FROM `shop`\.`users` WHERE `id` = \?/, [
          { id: 7, email: "alice@example.com" },
        ])
        // Outgoing FKs from orders: orders.user_id → users.id
        .whenSql(/KEY_COLUMN_USAGE.*kcu\.TABLE_NAME IN/s, [
          {
            TABLE_NAME: "orders",
            COLUMN_NAME: "user_id",
            REFERENCED_TABLE_SCHEMA: "shop",
            REFERENCED_TABLE_NAME: "users",
            REFERENCED_COLUMN_NAME: "id",
            UPDATE_RULE: "RESTRICT",
            DELETE_RULE: "CASCADE",
          },
        ])
        // Incoming FKs targeting orders: nothing on level 0
        // (depth=1 doesn't reach further than parents anyway)
        .whenSql(/KEY_COLUMN_USAGE.*kcu\.REFERENCED_TABLE_NAME IN/s, [])
    );
  }

  it("walks one hop to the parent and records the FK edge", async () => {
    registerMockConnection(CONN, fixtureRunner(), { database: DB });
    const r = await handleTraverseFk({
      connection: CONN,
      table: "orders",
      primary_key_value: 42,
      depth: 1,
      direction: "parents",
    });
    expect("isError" in r && r.isError).toBeFalsy();

    const sc = r.structuredContent as {
      nodes: Array<{ id: string; table: string }>;
      edges: Array<{
        from: string;
        to: string;
        via: string;
        direction: string;
      }>;
      depth_reached: number;
      total_node_cap_hit: boolean;
    };

    // Seed + 1 parent = 2 nodes.
    expect(sc.nodes).toHaveLength(2);
    const tables = sc.nodes.map((n) => n.table).sort();
    expect(tables).toEqual(["orders", "users"]);

    // One edge: orders → users via user_id → id.
    expect(sc.edges).toHaveLength(1);
    expect(sc.edges[0]?.direction).toBe("parent");
    expect(sc.edges[0]?.via).toContain("orders.user_id");
    expect(sc.edges[0]?.via).toContain("users.id");

    expect(sc.depth_reached).toBeGreaterThanOrEqual(1);
    expect(sc.total_node_cap_hit).toBe(false);
  });

  it("returns just the seed node when direction='children' and there are no incoming FKs", async () => {
    registerMockConnection(CONN, fixtureRunner(), { database: DB });
    const r = await handleTraverseFk({
      connection: CONN,
      table: "orders",
      primary_key_value: 42,
      depth: 2,
      direction: "children",
    });
    const sc = r.structuredContent as {
      nodes: Array<{ id: string }>;
      edges: Array<unknown>;
    };
    expect(sc.nodes).toHaveLength(1); // just the seed
    expect(sc.edges).toHaveLength(0);
  });

  it("renders a tree-ish text body that mentions the seed and edge count", async () => {
    registerMockConnection(CONN, fixtureRunner(), { database: DB });
    const r = await handleTraverseFk({
      connection: CONN,
      table: "orders",
      primary_key_value: 42,
      depth: 1,
      direction: "parents",
    });
    const text =
      (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
    expect(text).toContain("Traversal from orders.id = 42");
    expect(text).toContain("2 unique row(s)");
    expect(text).toContain("1 edge(s)");
  });
});

// ── cycle detection ───────────────────────────────────────────────

describe("traverse_fk — cycle detection", () => {
  it("dedupes a row that's reached twice via different paths", async () => {
    // Build a tiny graph where orders.user_id = 7 AND users.id = 7
    // and there's an incoming FK from orders to users — so the
    // children-of-users step would re-walk orders.id = 42, which
    // we've already visited.
    const runner = new MockRunner()
      .whenSql(/KEY_COLUMN_USAGE[\s\S]*CONSTRAINT_NAME = 'PRIMARY'/, [
        { COLUMN_NAME: "id" },
      ])
      .whenSql(/SELECT \* FROM `shop`\.`orders` WHERE `id` = \?/, [
        { id: 42, user_id: 7, total: 99.99 },
      ])
      .whenSql(/SELECT \* FROM `shop`\.`users` WHERE `id` = \?/, [
        { id: 7, email: "alice@example.com" },
      ])
      // Incoming FK to users from orders
      .whenSql(/KEY_COLUMN_USAGE.*kcu\.REFERENCED_TABLE_NAME IN/s, [
        {
          TABLE_NAME: "orders",
          COLUMN_NAME: "user_id",
          REFERENCED_TABLE_SCHEMA: "shop",
          REFERENCED_TABLE_NAME: "users",
          REFERENCED_COLUMN_NAME: "id",
          UPDATE_RULE: "RESTRICT",
          DELETE_RULE: "CASCADE",
        },
      ])
      // Outgoing FK from orders to users
      .whenSql(/KEY_COLUMN_USAGE.*kcu\.TABLE_NAME IN/s, [
        {
          TABLE_NAME: "orders",
          COLUMN_NAME: "user_id",
          REFERENCED_TABLE_SCHEMA: "shop",
          REFERENCED_TABLE_NAME: "users",
          REFERENCED_COLUMN_NAME: "id",
          UPDATE_RULE: "RESTRICT",
          DELETE_RULE: "CASCADE",
        },
      ])
      // Children of users: orders WHERE user_id = 7 (which is the seed!)
      .whenSql(/SELECT \* FROM `shop`\.`orders` WHERE `user_id` = \?/, [
        { id: 42, user_id: 7, total: 99.99 },
      ]);
    registerMockConnection(CONN, runner, { database: DB });

    const r = await handleTraverseFk({
      connection: CONN,
      table: "orders",
      primary_key_value: 42,
      depth: 3,
      direction: "both",
    });
    const sc = r.structuredContent as {
      nodes: Array<{ id: string }>;
    };
    // Even though orders#42 is reachable from itself (orders → users → orders),
    // visited deduplication keeps the unique-node count to 2.
    const uniqueIds = new Set(sc.nodes.map((n) => n.id));
    expect(uniqueIds.size).toBe(2);
    expect(uniqueIds.has(`orders#42`)).toBe(true);
    expect(uniqueIds.has(`users#7`)).toBe(true);
  });
});

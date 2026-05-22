import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, newTraceId, runWithContext } from "../log.js";

let captured: string[] = [];
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captured = [];
  spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    captured.push(String(line));
  });
});

afterEach(() => {
  spy.mockRestore();
});

describe("newTraceId", () => {
  it("produces 8-character hex strings", () => {
    for (let i = 0; i < 100; i++) {
      const id = newTraceId();
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("produces values that collide only with vanishing probability", () => {
    const set = new Set<string>();
    for (let i = 0; i < 10_000; i++) set.add(newTraceId());
    // 53-bit randomness → 8 hex char prefix is well below birthday collisions
    expect(set.size).toBeGreaterThan(9990);
  });
});

describe("runWithContext", () => {
  it("attaches traceId + toolName to every log within the async tree", async () => {
    await runWithContext(
      { traceId: "abcd1234", toolName: "list_tables" },
      async () => {
        log("info", "step one");
        await new Promise((r) => setTimeout(r, 1));
        log("warn", "step two", { extra: 42 });
      },
    );

    expect(captured).toHaveLength(2);
    const [first, second] = captured;
    expect(first).toContain('"traceId":"abcd1234"');
    expect(first).toContain('"toolName":"list_tables"');
    expect(second).toContain('"traceId":"abcd1234"');
    expect(second).toContain('"extra":42');
  });

  it("isolates contexts: nested runs see their own traceId", async () => {
    const outer = "out00000";
    const inner = "in000000";

    await runWithContext({ traceId: outer, toolName: "outer" }, async () => {
      log("info", "outer-before");
      await runWithContext(
        { traceId: inner, toolName: "inner" },
        async () => {
          log("info", "inner-during");
        },
      );
      log("info", "outer-after");
    });

    expect(captured[0]).toContain(outer);
    expect(captured[1]).toContain(inner);
    expect(captured[2]).toContain(outer);
  });

  it("does NOT leak context to log() calls made outside the run", () => {
    log("info", "before");
    expect(captured[0]).not.toContain("traceId");
  });

  it("explicit ctx args override the ambient context on key collision", async () => {
    await runWithContext(
      { traceId: "ambient1", toolName: "x" },
      async () => {
        log("info", "msg", { traceId: "override" });
      },
    );

    expect(captured[0]).toContain('"traceId":"override"');
  });
});

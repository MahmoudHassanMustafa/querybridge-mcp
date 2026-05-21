import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  expandTilde,
  escapeId,
  qualifiedTable,
  toolOk,
  toolError,
  toolHandler,
  formatAsTable,
  humanSize,
  stripSQLComments,
  sanitizeErrorMessage,
  log,
  setLogSink,
  markLogSinkConnected,
  buildHostVerifier,
} from "../helpers.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

// ── expandTilde ─────────────────────────────────────────────────────

describe("expandTilde", () => {
  it("expands ~/ to home directory", () => {
    expect(expandTilde("~/.ssh/key")).toBe(`${homedir()}/.ssh/key`);
  });

  it("expands bare ~ to home directory", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  it("does not expand ~ in the middle of a path", () => {
    expect(expandTilde("/home/~user")).toBe("/home/~user");
  });

  it("returns absolute paths unchanged", () => {
    expect(expandTilde("/etc/ssl/cert.pem")).toBe("/etc/ssl/cert.pem");
  });

  it("returns relative paths unchanged", () => {
    expect(expandTilde("./config.json")).toBe("./config.json");
  });
});

// ── escapeId ────────────────────────────────────────────────────────

describe("escapeId", () => {
  it("wraps name in backticks", () => {
    expect(escapeId("users")).toBe("`users`");
  });

  it("doubles backticks inside the name", () => {
    expect(escapeId("my`table")).toBe("`my``table`");
  });

  it("handles multiple backticks", () => {
    expect(escapeId("a`b`c")).toBe("`a``b``c`");
  });

  it("rejects empty names", () => {
    expect(() => escapeId("")).toThrow("cannot be empty");
  });

  it("rejects names containing NUL bytes", () => {
    expect(() => escapeId("users\0")).toThrow("NUL bytes");
  });

  it("rejects names longer than 64 characters", () => {
    expect(() => escapeId("a".repeat(65))).toThrow("too long");
  });

  it("accepts names exactly 64 characters", () => {
    expect(escapeId("a".repeat(64))).toBe("`" + "a".repeat(64) + "`");
  });

  it("handles special characters safely", () => {
    expect(escapeId("table; DROP TABLE--")).toBe("`table; DROP TABLE--`");
  });
});

// ── qualifiedTable ──────────────────────────────────────────────────

describe("qualifiedTable", () => {
  it("combines db and table with dot", () => {
    expect(qualifiedTable("mydb", "users")).toBe("`mydb`.`users`");
  });

  it("escapes both parts", () => {
    expect(qualifiedTable("my`db", "my`table")).toBe("`my``db`.`my``table`");
  });
});

// ── toolOk / toolError ──────────────────────────────────────────────

describe("toolOk", () => {
  it("wraps text in MCP content format", () => {
    expect(toolOk("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });
});

describe("toolError", () => {
  it("returns error with isError flag", () => {
    const result = toolError("something broke");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("something broke");
  });

  it("appends hint when provided", () => {
    const result = toolError("fail", "try again");
    expect(result.content[0].text).toBe("fail\nHint: try again");
  });
});

// ── formatAsTable ───────────────────────────────────────────────────

describe("formatAsTable", () => {
  it("returns (empty) for empty array", () => {
    expect(formatAsTable([])).toBe("(empty)");
  });

  it("formats single row", () => {
    const result = formatAsTable([{ id: 1, name: "alice" }]);
    expect(result).toContain("id");
    expect(result).toContain("name");
    expect(result).toContain("1");
    expect(result).toContain("alice");
  });

  it("formats multiple rows with alignment", () => {
    const rows = [
      { col: "a", val: "short" },
      { col: "b", val: "longer value" },
    ];
    const lines = formatAsTable(rows).split("\n");
    expect(lines.length).toBe(4); // header + separator + 2 rows
    expect(lines[1]).toMatch(/^-+\+-+$/); // separator line
  });

  it("shows NULL for null/undefined values", () => {
    const result = formatAsTable([{ a: null, b: undefined }]);
    expect(result).toContain("NULL");
  });

  it("truncates long values with maxWidth", () => {
    const result = formatAsTable([{ col: "a".repeat(100) }], { maxWidth: 20 });
    expect(result).toContain("...");
    expect(result).not.toContain("a".repeat(100));
  });

  it("renders JSON-column objects as JSON, not [object Object]", () => {
    const result = formatAsTable(
      [{ services: { web: true, db: "postgres" } }],
      { maxWidth: 100 },
    );
    expect(result).not.toContain("[object Object]");
    expect(result).toContain('{"web":true,"db":"postgres"}');
  });

  it("renders JSON-column arrays with structure preserved", () => {
    const result = formatAsTable([{ tags: ["a", "b", "c"] }], {
      maxWidth: 100,
    });
    expect(result).toContain('["a","b","c"]');
  });

  it("leaves Date values stringifying as before (not JSON-quoted)", () => {
    const d = new Date("2026-04-15T10:00:00Z");
    const result = formatAsTable([{ ts: d }], { maxWidth: 200 });
    expect(result).toContain(String(d));
    expect(result).not.toContain(`"${d.toISOString()}"`);
  });

  it("renders Buffer/BLOB columns as size metadata, not raw bytes", () => {
    const buf = Buffer.from("hello");
    const result = formatAsTable([{ blob: buf }], { maxWidth: 100 });
    expect(result).not.toContain('"type":"Buffer"');
    expect(result).toContain("<Buffer 5 bytes>");
  });

  it("renders Uint8Array the same as Buffer", () => {
    const arr = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const result = formatAsTable([{ blob: arr }], { maxWidth: 100 });
    expect(result).toContain("<Buffer 7 bytes>");
  });

  it("does not decode binary BLOBs as UTF-8 garbage", () => {
    const binary = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]);
    const result = formatAsTable([{ blob: binary }], { maxWidth: 100 });
    expect(result).toContain("<Buffer 5 bytes>");
    // the raw bytes should not appear verbatim
    expect(result).not.toContain(binary.toString("utf8"));
  });

  it("enforces a byte cap and appends a truncation note", () => {
    // 200 rows × ~80 bytes/row ≈ 16KB raw; cap at 4KB should truncate
    const rows = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      data: "x".repeat(60),
    }));
    const result = formatAsTable(rows, { maxWidth: 100, maxBytes: 4 * 1024 });
    expect(result).toContain("(truncated");
    expect(result).toContain("row(s) omitted");
    // result should be close to the cap, not the full ~16KB
    expect(Buffer.byteLength(result, "utf8")).toBeLessThan(5 * 1024);
  });

  it("does not truncate when output fits under the cap", () => {
    const rows = [{ id: 1, name: "alice" }];
    const result = formatAsTable(rows, { maxBytes: 1024 });
    expect(result).not.toContain("(truncated");
  });

  it("falls back safely on circular objects", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() =>
      formatAsTable([{ col: obj }], { maxWidth: 100 }),
    ).not.toThrow();
  });
});

// ── humanSize ───────────────────────────────────────────────────────

describe("humanSize", () => {
  it("returns N/A for null", () => {
    expect(humanSize(null)).toBe("N/A");
  });

  it("returns N/A for undefined", () => {
    expect(humanSize(undefined)).toBe("N/A");
  });

  it("formats bytes", () => {
    expect(humanSize(500)).toBe("500 B");
  });

  it("formats kilobytes", () => {
    expect(humanSize(2048)).toBe("2.0 KB");
  });

  it("formats megabytes", () => {
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats gigabytes", () => {
    expect(humanSize(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });

  it("handles zero", () => {
    expect(humanSize(0)).toBe("0 B");
  });
});

// ── stripSQLComments ────────────────────────────────────────────────

describe("stripSQLComments", () => {
  it("strips block comments", () => {
    expect(stripSQLComments("/* comment */ SELECT 1")).toBe("SELECT 1");
  });

  it("strips multi-line block comments", () => {
    expect(stripSQLComments("/*\nmulti\nline\n*/ SELECT 1")).toBe("SELECT 1");
  });

  it("strips -- line comments", () => {
    expect(stripSQLComments("SELECT 1 -- comment")).toBe("SELECT 1");
  });

  it("strips # line comments", () => {
    expect(stripSQLComments("SELECT 1 # comment")).toBe("SELECT 1");
  });

  it("strips multiple comment types", () => {
    const result = stripSQLComments("/* a */ SELECT -- b\n1 # c");
    expect(result).toContain("SELECT");
    expect(result).toContain("1");
    expect(result).not.toContain("/* a */");
    expect(result).not.toContain("-- b");
    expect(result).not.toContain("# c");
  });

  it("returns empty string for comment-only input", () => {
    expect(stripSQLComments("/* just a comment */")).toBe("");
  });

  it("preserves query with no comments", () => {
    expect(stripSQLComments("SELECT * FROM users")).toBe("SELECT * FROM users");
  });
});

// ── sanitizeErrorMessage ────────────────────────────────────────────

describe("sanitizeErrorMessage", () => {
  it("strips user@host patterns", () => {
    expect(
      sanitizeErrorMessage("Access denied for user 'app'@'10.0.0.5'"),
    ).toBe("Access denied for user '***'@'***'");
  });

  it("strips IPv4 addresses", () => {
    expect(
      sanitizeErrorMessage("Can't connect to MySQL server on 192.168.1.42"),
    ).toBe("Can't connect to MySQL server on ***");
  });

  it("strips multiple IPs in one message", () => {
    expect(sanitizeErrorMessage("tried 10.0.0.1 then 10.0.0.2")).toBe(
      "tried *** then ***",
    );
  });

  it("leaves unrelated text intact", () => {
    expect(sanitizeErrorMessage("Table 'users' doesn't exist")).toBe(
      "Table 'users' doesn't exist",
    );
  });

  it("is idempotent", () => {
    const once = sanitizeErrorMessage("user 'a'@'1.2.3.4' failed");
    expect(sanitizeErrorMessage(once)).toBe(once);
  });
});

// ── log ─────────────────────────────────────────────────────────────

describe("log", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("writes to stderr, never stdout", () => {
    log("info", "hello");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("formats level in uppercase with prefix", () => {
    log("warn", "something");
    expect(stderrSpy).toHaveBeenCalledWith("[querybridge-mcp] WARN something");
  });

  it("appends ctx as JSON when provided", () => {
    log("error", "boom", { connection: "prod", code: 42 });
    expect(stderrSpy).toHaveBeenCalledWith(
      '[querybridge-mcp] ERROR boom {"connection":"prod","code":42}',
    );
  });

  it("omits suffix when ctx is undefined", () => {
    log("info", "ready");
    expect(stderrSpy).toHaveBeenCalledWith("[querybridge-mcp] INFO ready");
  });
});

// ── log forwarding via MCP sink ─────────────────────────────────────

describe("log → MCP sink forwarding", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    // Reset module-level sink between tests by re-registering a no-op.
    setLogSink({
      sendLoggingMessage: () => Promise.resolve(),
    });
  });

  it("does not forward when sink is not yet connected", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setLogSink({ sendLoggingMessage: send });
    // markLogSinkConnected() intentionally NOT called

    log("info", "hello");
    // give any potential microtask a tick to flush
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards info → 'info' once connected", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setLogSink({ sendLoggingMessage: send });
    markLogSinkConnected();

    log("info", "ready", { connection: "prod" });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    const call = send.mock.calls[0][0];
    expect(call.level).toBe("info");
    expect(call.logger).toBe("querybridge-mcp");
    expect(call.data).toEqual({ msg: "ready", connection: "prod" });
  });

  it("maps warn → 'warning' for MCP spec compliance", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setLogSink({ sendLoggingMessage: send });
    markLogSinkConnected();

    log("warn", "uh oh");
    await Promise.resolve();
    expect(send.mock.calls[0][0].level).toBe("warning");
  });

  it("maps error → 'error'", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    setLogSink({ sendLoggingMessage: send });
    markLogSinkConnected();

    log("error", "boom");
    await Promise.resolve();
    expect(send.mock.calls[0][0].level).toBe("error");
  });

  it("never lets a failing sink break the calling code", async () => {
    const send = vi.fn().mockRejectedValue(new Error("transport closed"));
    setLogSink({ sendLoggingMessage: send });
    markLogSinkConnected();

    expect(() => log("info", "hello")).not.toThrow();
    // The fire-and-forget catch logs the failure as a second stderr line.
    await new Promise((r) => setTimeout(r, 5));
    expect(stderrSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── toolHandler ─────────────────────────────────────────────────────

describe("toolHandler", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("passes through a successful result and audit-logs INFO", async () => {
    const wrapped = toolHandler("demo", async () => toolOk("fine"));
    const res = await wrapped({ connection: "prod" });
    expect(res.content[0].text).toBe("fine");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[querybridge-mcp\] INFO demo /);
    expect(line).toContain('"connection":"prod"');
    expect(line).toContain('"elapsedMs":');
  });

  it("passes through an early-returned toolError and audit-logs WARN with rejected:true", async () => {
    const wrapped = toolHandler("demo", async () =>
      toolError("precondition failed"),
    );
    const res = await wrapped({});
    expect(res.content[0].text).toBe("precondition failed");
    expect("isError" in res && res.isError).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toMatch(/^\[querybridge-mcp\] WARN demo /);
    expect(stderrSpy.mock.calls[0][0]).toContain('"rejected":true');
  });

  it("catches throws, logs to stderr, returns sanitized toolError", async () => {
    const wrapped = toolHandler("my_tool", async () => {
      throw new Error("Access denied for user 'root'@'10.1.2.3'");
    });
    const res = await wrapped({ connection: "prod" });
    expect("isError" in res && res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      "my_tool failed: Access denied for user '***'@'***'",
    );
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const logged = stderrSpy.mock.calls[0][0] as string;
    // Operator-side log carries the RAW (unsanitized) error
    expect(logged).toContain("my_tool failed");
    expect(logged).toContain("'root'@'10.1.2.3'");
    expect(logged).toContain('"connection":"prod"');
  });

  it("handles non-Error throws", async () => {
    const wrapped = toolHandler("demo", async () => {
      throw "plain string";
    });
    const res = await wrapped({});
    expect("isError" in res && res.isError).toBe(true);
    expect(res.content[0].text).toBe("demo failed: plain string");
  });

  it("tolerates missing connection arg in logged ctx", async () => {
    const wrapped = toolHandler("demo", async () => {
      throw new Error("nope");
    });
    const res = await wrapped({});
    expect("isError" in res && res.isError).toBe(true);
    const logged = stderrSpy.mock.calls[0][0] as string;
    // undefined connection is skipped by JSON.stringify
    expect(logged).not.toContain('"connection"');
  });
});

// ── buildHostVerifier ───────────────────────────────────────────────

describe("buildHostVerifier", () => {
  // A fixed "host key" buffer and its precomputed SHA256 base64 fingerprint
  const hostKey = Buffer.from("fake-ssh-host-key-for-testing");
  const correctFp = createHash("sha256")
    .update(hostKey)
    .digest("base64")
    .replace(/=+$/, "");

  it("returns undefined when no fingerprint is provided", () => {
    expect(buildHostVerifier(undefined)).toBeUndefined();
    expect(buildHostVerifier("")).toBeUndefined();
  });

  it("accepts a matching fingerprint", () => {
    const verify = buildHostVerifier(correctFp);
    expect(verify).toBeDefined();
    expect(verify!(hostKey)).toBe(true);
  });

  it("accepts fingerprint with SHA256: prefix", () => {
    const verify = buildHostVerifier(`SHA256:${correctFp}`);
    expect(verify!(hostKey)).toBe(true);
  });

  it("tolerates base64 padding on the configured fingerprint", () => {
    const verify = buildHostVerifier(`SHA256:${correctFp}==`);
    expect(verify!(hostKey)).toBe(true);
  });

  it("rejects a mismatched fingerprint", () => {
    const verify = buildHostVerifier(correctFp);
    const tamperedKey = Buffer.from("different-key-entirely");
    expect(verify!(tamperedKey)).toBe(false);
  });

  it("rejects a malformed fingerprint without throwing", () => {
    const verify = buildHostVerifier("not-a-real-fingerprint");
    expect(verify!(hostKey)).toBe(false);
  });

  it("rejects when fingerprint length doesn't match hash length", () => {
    // Short fingerprint — can't possibly be a real SHA256
    const verify = buildHostVerifier("abc");
    expect(verify!(hostKey)).toBe(false);
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetConnectionsForTests,
  registerMockConnection,
} from "../connection.js";
import { MockRunner } from "./utils/mock-runner.js";
import {
  handleStreamingQuery,
  validateOutputPath,
} from "../tools/streaming-tools.js";

// The streaming pump itself needs a real mysql2 pool (it reaches into
// the underlying callback connection for .stream()), so the deep
// behaviour lives in the integration suite. These unit tests cover the
// gates *before* the stream opens: SQL validation, path safety, and
// the connection lookup. Together they protect the surface an agent
// can probe without ever needing a database.

let TMP: string;

beforeEach(async () => {
  __resetConnectionsForTests();
  TMP = await mkdtemp(path.join(tmpdir(), "qb-stream-"));
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

// ── validateOutputPath ────────────────────────────────────────────

describe("validateOutputPath", () => {
  it("accepts a fresh path under tmp", async () => {
    const target = path.join(TMP, "out.ndjson");
    const result = await validateOutputPath(target, false);
    expect(result.ok).toBe(true);
    expect(result.resolved).toBe(target);
  });

  it("rejects empty string", async () => {
    const result = await validateOutputPath("", false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/required/);
  });

  it("rejects paths containing a null byte", async () => {
    const result = await validateOutputPath("/tmp/foo\0bar", false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/null byte/);
  });

  it("rejects /proc paths", async () => {
    const result = await validateOutputPath("/proc/self/mem", false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\/proc\//);
  });

  it("rejects /dev paths", async () => {
    const result = await validateOutputPath("/dev/null", false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\/dev\//);
  });

  it("refuses to clobber an existing file without overwrite=true", async () => {
    const target = path.join(TMP, "exists.ndjson");
    await writeFile(target, "previous run\n");
    const result = await validateOutputPath(target, false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/overwrite=true/);
  });

  it("accepts an existing file when overwrite=true", async () => {
    const target = path.join(TMP, "exists.ndjson");
    await writeFile(target, "previous run\n");
    const result = await validateOutputPath(target, true);
    expect(result.ok).toBe(true);
  });

  it("rejects a directory", async () => {
    const result = await validateOutputPath(TMP, true);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/directory/);
  });

  it("resolves relative paths against cwd", async () => {
    const result = await validateOutputPath("relative-name.ndjson", false);
    expect(result.ok).toBe(true);
    expect(path.isAbsolute(result.resolved)).toBe(true);
  });
});

// ── handleStreamingQuery — pre-stream gates ───────────────────────

describe("handleStreamingQuery", () => {
  const CONN = "mock-stream";

  function registerConn() {
    registerMockConnection(CONN, new MockRunner(), { database: "shop" });
  }

  it("rejects non-SELECT SQL with a clear toolError", async () => {
    registerConn();
    const result = await handleStreamingQuery({
      connection: CONN,
      query: "DELETE FROM users",
      output_path: path.join(TMP, "out.ndjson"),
    });
    expect("isError" in result && result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/SELECT/);
  });

  it("rejects SELECT INTO OUTFILE", async () => {
    registerConn();
    const result = await handleStreamingQuery({
      connection: CONN,
      query: "SELECT * FROM users INTO OUTFILE '/tmp/x'",
      output_path: path.join(TMP, "out.ndjson"),
    });
    expect("isError" in result && result.isError).toBe(true);
  });

  it("rejects WITH ... DELETE (write hidden behind a CTE)", async () => {
    registerConn();
    const result = await handleStreamingQuery({
      connection: CONN,
      query: "WITH t AS (SELECT 1) DELETE FROM users WHERE id = 1",
      output_path: path.join(TMP, "out.ndjson"),
    });
    expect("isError" in result && result.isError).toBe(true);
  });

  it("rejects an invalid output_path before touching the database", async () => {
    registerConn();
    const result = await handleStreamingQuery({
      connection: CONN,
      query: "SELECT 1",
      output_path: "/proc/self/cmdline",
    });
    expect("isError" in result && result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/\/proc\//);
  });

  it("refuses to clobber an existing file by default", async () => {
    registerConn();
    const target = path.join(TMP, "occupied.ndjson");
    await writeFile(target, "previous run\n");
    const result = await handleStreamingQuery({
      connection: CONN,
      query: "SELECT 1",
      output_path: target,
    });
    expect("isError" in result && result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/overwrite=true/);
  });

  it("throws when the connection has no real pool (handled by toolHandler in prod)", async () => {
    // Mock connections register a runner but no pool; streaming reaches
    // for the pool directly via getPool() and throws. In production the
    // outer toolHandler turns this into a sanitised toolError — here we
    // assert the boundary behaviour, which is that the lower-level
    // handler propagates a recognisable Error.
    registerConn();
    await expect(
      handleStreamingQuery({
        connection: CONN,
        query: "SELECT 1",
        output_path: path.join(TMP, "out.ndjson"),
      }),
    ).rejects.toThrow(/mock without a backing pool/);
  });
});

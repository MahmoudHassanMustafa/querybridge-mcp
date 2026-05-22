import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetConnectionsForTests,
  registerMockConnection,
} from "../connection.js";
import { STREAM_PROGRESS_ROW_INTERVAL } from "../limits.js";
import { MockRunner } from "./utils/mock-runner.js";
import {
  handleStreamingQuery,
  pumpStream,
  validateOutputPath,
} from "../tools/streaming-tools.js";

// The mysql2 row stream itself needs a real pool — that lives in the
// integration suite. These unit tests cover the gates *before* the
// stream opens (SQL validation, path safety, connection lookup), and
// drive `pumpStream` directly with a synthetic Readable to verify
// progress-notification cadence and cap-stop killer wiring without a
// container.

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

// ── pumpStream — progress + cap-stop wiring ──────────────────────

describe("pumpStream", () => {
  /** Make a writer + close it cleanly so file content can be inspected. */
  async function openWriter(target: string) {
    const writer = createWriteStream(target, { encoding: "utf8" });
    await once(writer, "open");
    return writer;
  }

  it("emits a notifications/progress every STREAM_PROGRESS_ROW_INTERVAL rows", async () => {
    // 2× the interval guarantees we hit the boundary twice and never on
    // the final row — that's the cadence we want to verify.
    const total = STREAM_PROGRESS_ROW_INTERVAL * 2 + 250;
    const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
    const writer = await openWriter(path.join(TMP, "progress.ndjson"));

    const notifications: Array<{
      method: string;
      params: Record<string, unknown>;
    }> = [];
    const extra = {
      _meta: { progressToken: "tok-1" },
      sendNotification: async (n: {
        method: string;
        params: Record<string, unknown>;
      }) => {
        notifications.push(n);
      },
    };

    const result = await pumpStream(
      Readable.from(rows, { objectMode: true }),
      writer,
      async () => {
        throw new Error("killer must not run when no cap is hit");
      },
      42,
      { maxRows: 100_000, maxBytes: 100_000_000 },
      extra,
    );
    writer.end();
    await once(writer, "finish");

    expect(result.rowsWritten).toBe(total);
    expect(result.truncated).toBe(false);

    // Cadence: rows 1000 and 2000 → exactly 2 events for a 2250-row stream.
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toEqual({
      method: "notifications/progress",
      params: {
        progressToken: "tok-1",
        progress: STREAM_PROGRESS_ROW_INTERVAL,
        total: 100_000,
        message: STREAM_PROGRESS_ROW_INTERVAL + " rows streamed",
      },
    });
    expect(notifications[1]?.params).toMatchObject({
      progress: STREAM_PROGRESS_ROW_INTERVAL * 2,
      message: STREAM_PROGRESS_ROW_INTERVAL * 2 + " rows streamed",
    });
  });

  it("emits NO progress notifications when the client did not opt in", async () => {
    // No progressToken means the request didn't ask for progress.
    // emitProgress is required to be a no-op so we don't spam clients
    // that aren't listening.
    const writer = await openWriter(path.join(TMP, "no-progress.ndjson"));
    const rows = Array.from(
      { length: STREAM_PROGRESS_ROW_INTERVAL * 2 },
      (_, i) => ({ id: i }),
    );

    let calls = 0;
    const extra = {
      sendNotification: async () => {
        calls += 1;
      },
    };

    await pumpStream(
      Readable.from(rows, { objectMode: true }),
      writer,
      async () => {},
      42,
      { maxRows: 100_000, maxBytes: 100_000_000 },
      extra,
    );
    writer.end();
    await once(writer, "finish");
    expect(calls).toBe(0);
  });

  it("invokes the killer once with the connection id when max_rows is hit", async () => {
    const writer = await openWriter(path.join(TMP, "capped-rows.ndjson"));
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i }));

    const killerCalls: number[] = [];
    const result = await pumpStream(
      Readable.from(rows, { objectMode: true }),
      writer,
      async (id) => {
        killerCalls.push(id);
      },
      999, // fake connection id we expect to see forwarded
      { maxRows: 100, maxBytes: 100_000_000 },
      undefined,
    );
    writer.end();
    await once(writer, "finish");

    expect(result.truncated).toBe(true);
    expect(result.rowsWritten).toBe(100);
    // Fire-and-forget, but exactly once even though we drain another
    // 4900 rows after the cap is hit (the for-await pulls the remaining
    // buffer; the killIssued guard prevents re-firing).
    expect(killerCalls).toEqual([999]);

    const lines = (
      await readFile(path.join(TMP, "capped-rows.ndjson"), "utf8")
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(100);
  });

  it("invokes the killer when max_bytes would be exceeded by the next row", async () => {
    // Each row JSON-encodes to ~12 bytes ({"id":N}\n). max_bytes=120
    // stops between rows 8 and 11 depending on number width.
    const writer = await openWriter(path.join(TMP, "capped-bytes.ndjson"));
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: i }));

    const killerCalls: number[] = [];
    const result = await pumpStream(
      Readable.from(rows, { objectMode: true }),
      writer,
      async (id) => {
        killerCalls.push(id);
      },
      7,
      { maxRows: 100_000, maxBytes: 120 },
      undefined,
    );
    writer.end();
    await once(writer, "finish");

    expect(result.truncated).toBe(true);
    expect(result.bytesWritten).toBeLessThanOrEqual(120);
    expect(result.rowsWritten).toBeGreaterThan(0);
    expect(killerCalls).toEqual([7]);
  });

  it("survives a sendNotification that throws — the export still completes", async () => {
    // emitProgress wraps sendNotification in a try/catch. If a flaky
    // client connection raises mid-stream, the export must finish, not
    // abort midway through writing.
    const writer = await openWriter(path.join(TMP, "noisy-client.ndjson"));
    const rows = Array.from(
      { length: STREAM_PROGRESS_ROW_INTERVAL + 5 },
      (_, i) => ({ id: i }),
    );
    const extra = {
      _meta: { progressToken: "tok-bad" },
      sendNotification: async () => {
        throw new Error("client gone");
      },
    };

    const result = await pumpStream(
      Readable.from(rows, { objectMode: true }),
      writer,
      async () => {},
      42,
      { maxRows: 100_000, maxBytes: 100_000_000 },
      extra,
    );
    writer.end();
    await once(writer, "finish");

    expect(result.rowsWritten).toBe(STREAM_PROGRESS_ROW_INTERVAL + 5);
    expect(result.truncated).toBe(false);
  });
});

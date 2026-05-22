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
  handleCompareSchemaFile,
  validateSchemaPath,
} from "../tools/compare-schema-file.js";

// The actual schema-loading + diff path needs a real MySQL pool (it
// reaches getPool() and calls worker.query). Deep behaviour is covered
// by the integration suite. These unit tests guard the gates that run
// *before* the temp DB is created: path safety, scratch-connection
// writability, file-content validation.

let TMP: string;

beforeEach(async () => {
  __resetConnectionsForTests();
  TMP = await mkdtemp(path.join(tmpdir(), "qb-cmpsf-"));
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

// ── validateSchemaPath ────────────────────────────────────────────

describe("validateSchemaPath", () => {
  it("accepts an existing readable .sql file", async () => {
    const target = path.join(TMP, "schema.sql");
    await writeFile(target, "CREATE TABLE t (id INT);\n");
    const r = await validateSchemaPath(target);
    expect(r.ok).toBe(true);
    expect(r.resolved).toBe(target);
  });

  it("rejects empty path", async () => {
    const r = await validateSchemaPath("");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/required/);
  });

  it("rejects a null-byte path", async () => {
    const r = await validateSchemaPath("/tmp/foo\0bar.sql");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/null byte/);
  });

  it("rejects /proc paths", async () => {
    const r = await validateSchemaPath("/proc/self/cmdline");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\/proc\//);
  });

  it("rejects a directory", async () => {
    const r = await validateSchemaPath(TMP);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/regular file/);
  });

  it("rejects a missing path", async () => {
    const r = await validateSchemaPath(path.join(TMP, "ghost.sql"));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not be read/);
  });
});

// ── handleCompareSchemaFile — pre-load gates ──────────────────────

describe("handleCompareSchemaFile — pre-load gates", () => {
  it("refuses a read-only scratch connection up front", async () => {
    // The mock has no pool so the test never reaches CREATE DATABASE,
    // but the readonly check happens before pool acquisition.
    registerMockConnection("live", new MockRunner(), { database: "shop" });
    registerMockConnection("scratch_ro", new MockRunner(), {
      readonly: true,
    });

    const target = path.join(TMP, "schema.sql");
    await writeFile(target, "CREATE TABLE t (id INT);");

    const r = await handleCompareSchemaFile({
      live_connection: "live",
      scratch_connection: "scratch_ro",
      schema_path: target,
    });
    expect("isError" in r && r.isError).toBe(true);
    expect(
      (r.structuredContent as { code: string }).code,
    ).toBe("SCRATCH_CONNECTION_READONLY");
    const suggestions = (
      r.structuredContent as { suggestions: Array<{ tool: string }> }
    ).suggestions;
    expect(suggestions[0]?.tool).toBe("list_connections");
  });

  it("refuses an invalid schema_path before touching any database", async () => {
    registerMockConnection("live", new MockRunner(), { database: "shop" });
    registerMockConnection("scratch", new MockRunner(), { readonly: false });

    const r = await handleCompareSchemaFile({
      live_connection: "live",
      scratch_connection: "scratch",
      schema_path: "/proc/self/cmdline",
    });
    expect("isError" in r && r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe(
      "SCHEMA_PATH_INVALID",
    );
  });

  it("refuses a comment-only schema file (no actual statements)", async () => {
    registerMockConnection("live", new MockRunner(), { database: "shop" });
    registerMockConnection("scratch", new MockRunner(), { readonly: false });

    const target = path.join(TMP, "empty.sql");
    await writeFile(target, "-- nothing here\n/* still nothing */\n");

    const r = await handleCompareSchemaFile({
      live_connection: "live",
      scratch_connection: "scratch",
      schema_path: target,
    });
    expect("isError" in r && r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe(
      "SCHEMA_PATH_EMPTY",
    );
  });

  it("throws when the scratch mock connection has no real pool", async () => {
    // Once past the gates, the handler reaches getPool(scratch) which
    // throws for mocks. Production wraps the handler in toolHandler so
    // this surfaces as a sanitised toolError; here we assert the
    // underlying boundary behaviour.
    registerMockConnection("live", new MockRunner(), { database: "shop" });
    registerMockConnection("scratch", new MockRunner(), { readonly: false });

    const target = path.join(TMP, "schema.sql");
    await writeFile(target, "CREATE TABLE t (id INT);");

    await expect(
      handleCompareSchemaFile({
        live_connection: "live",
        scratch_connection: "scratch",
        schema_path: target,
      }),
    ).rejects.toThrow(/mock without a backing pool/);
  });
});

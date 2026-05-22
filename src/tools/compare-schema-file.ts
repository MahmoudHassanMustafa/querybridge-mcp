/**
 * `compare_schema_file` — drift detection against a checked-in `.sql`.
 *
 * Use case: CI guards a schema-as-source-of-truth file
 * (`schema.sql`) against production. If a developer adds a column in
 * a migration but forgets to update the canonical schema, this catches
 * it before merge.
 *
 * Approach: load the file into a temp database on a **writable scratch
 * connection**, then delegate to the existing `compare_schemas` engine
 * with (scratch:temp_db) as the source side and (live_connection:
 * live_database) as the target. MySQL parses the DDL natively — we
 * never write our own SQL parser.
 *
 * Why a scratch connection: the file's CREATE statements have to
 * actually run somewhere to be introspectable. In CI this is typically
 * a fresh MySQL service container; in dev it's a local sandbox.
 *
 * Privilege scoping: temp DBs always live under the `_qbmcp_check_*`
 * prefix (see `newTempDbName` below), so the scratch user should be
 * narrowed to just that namespace — never `*.*`. The minimum grant is:
 *
 *   GRANT CREATE, DROP, ALL PRIVILEGES ON `_qbmcp_check_%`.*
 *     TO '<scratch_user>'@'<host>';
 *
 * The full hardening recipe lives in SECURITY.md under "Security
 * Considerations for Operators".
 *
 * V1 limitations:
 *
 *   - **No DELIMITER support.** Stored routines / triggers in the
 *     file that contain `;` inside their BEGIN..END body will not
 *     split cleanly. Run those through a tool that understands
 *     DELIMITER (e.g. the `mysql` CLI) before loading, or accept
 *     that routines/triggers can't be diffed by this tool yet.
 *   - **No data loaded.** Only DDL — INSERTs in the file aren't
 *     required for schema comparison and would slow down the temp
 *     DB build for no benefit.
 *   - **Bounded file size.** 16 MiB cap on the input file to keep the
 *     in-memory string + statement-stream bounded.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getConnectionConfig,
  getPool,
  getQueryTimeout,
} from "../connection.js";
import { resolveDb } from "../db/resolve.js";
import { escapeId } from "../sql/identifiers.js";
import { splitSqlStatements } from "../sql/split.js";
import { SCOPES, type Scope } from "./compare/scope.js";
import { runSchemaComparison } from "./compare/engine.js";
import { log } from "../log.js";
import {
  toolError,
  toolHandler,
  type ToolExtra,
  type ToolResult,
} from "../tool-runtime.js";

// ── caps ───────────────────────────────────────────────────────────

/**
 * Largest `.sql` file we'll try to load. 16 MiB is enough for hundreds
 * of CREATE TABLE statements at typical column counts, and bounds the
 * worst case where an operator points at a multi-GB dump file by
 * accident.
 */
const MAX_SCHEMA_FILE_BYTES = 16 * 1024 * 1024;

// ── path safety ───────────────────────────────────────────────────

const FORBIDDEN_READ_PREFIXES = ["/proc/", "/dev/", "/sys/", "/boot/"];

interface PathValidation {
  ok: boolean;
  resolved: string;
  size?: number;
  reason?: string;
}

export async function validateSchemaPath(raw: string): Promise<PathValidation> {
  if (raw.length === 0) {
    return { ok: false, resolved: "", reason: "schema_path is required." };
  }
  if (raw.includes("\0")) {
    return {
      ok: false,
      resolved: "",
      reason: "schema_path contains a null byte.",
    };
  }
  const resolved = path.resolve(raw);
  for (const forbidden of FORBIDDEN_READ_PREFIXES) {
    if (resolved === forbidden.slice(0, -1) || resolved.startsWith(forbidden)) {
      return {
        ok: false,
        resolved,
        reason: `schema_path resolves under ${forbidden} which is not readable by this tool.`,
      };
    }
  }
  let info;
  try {
    info = await stat(resolved);
  } catch (err) {
    return {
      ok: false,
      resolved,
      reason: `schema_path could not be read: ${(err as Error).message}`,
    };
  }
  if (!info.isFile()) {
    return {
      ok: false,
      resolved,
      reason: "schema_path is not a regular file.",
    };
  }
  if (info.size > MAX_SCHEMA_FILE_BYTES) {
    return {
      ok: false,
      resolved,
      reason: `schema_path is ${info.size} bytes — exceeds the ${MAX_SCHEMA_FILE_BYTES}-byte cap.`,
    };
  }
  return { ok: true, resolved, size: info.size };
}

// ── temp DB name ──────────────────────────────────────────────────

/**
 * Build a temp database name that:
 *
 *   - starts with `_qbmcp_check_` so an operator sweeping for leftover
 *     scratch databases (e.g. after a process kill) can grep for them;
 *   - includes a 12-hex-char random suffix so concurrent CI runs on the
 *     same scratch server don't collide.
 *
 * MySQL allows up to 64 chars; we use ~25. Backticks aren't needed in
 * the identifier itself — they're added at the SQL boundary via
 * `escapeId`.
 */
function newTempDbName(): string {
  return "_qbmcp_check_" + crypto.randomBytes(6).toString("hex");
}

// ── handler ────────────────────────────────────────────────────────

interface CompareSchemaFileArgs {
  // Wire format is snake_case to match streaming_query and the rest
  // of the recent additions; we keep the same shape internally rather
  // than remap to camelCase. The open index signature is required by
  // toolHandler's `A extends Record<string, unknown>` constraint.
  live_connection: string;
  live_database?: string | undefined;
  scratch_connection: string;
  schema_path: string;
  tables?: string[] | undefined;
  scope?: Scope[] | undefined;
  summaryOnly?: boolean | undefined;
  [key: string]: unknown;
}

export async function handleCompareSchemaFile(
  args: CompareSchemaFileArgs,
  extra?: ToolExtra,
): Promise<ToolResult> {
  const {
    live_connection: liveConnection,
    live_database: liveDatabase,
    scratch_connection: scratchConnection,
    schema_path: schemaPath,
    tables,
    scope,
    summaryOnly,
  } = args;

  // The live side must resolve to a real database so the diff has
  // somewhere to compare against. The scratch side comes from the
  // temp DB we create below — it does NOT use resolveDb.
  const live = resolveDb(liveConnection, liveDatabase);
  if ("error" in live) return live.error;

  // Scratch must be a *writable* connection — we're going to CREATE
  // DATABASE, CREATE TABLE, and DROP DATABASE on it. Refusing up front
  // is clearer than letting the first DDL fail with a session-level
  // read-only error from MySQL.
  const scratchConfig = getConnectionConfig(scratchConnection);
  if (scratchConfig.readonly !== false) {
    return toolError(
      `scratch_connection "${scratchConnection}" is read-only.`,
      {
        code: "SCRATCH_CONNECTION_READONLY",
        hint: "compare_schema_file needs to create + drop a temp DB on the scratch side. Configure the connection with readonly: false.",
        suggestions: [
          {
            tool: "list_connections",
            reason: "find a writable connection to use as scratch",
          },
        ],
      },
    );
  }

  const pathCheck = await validateSchemaPath(schemaPath);
  if (!pathCheck.ok) {
    return toolError(pathCheck.reason ?? "schema_path is invalid.", {
      code: "SCHEMA_PATH_INVALID",
    });
  }

  const fileText = await readFile(pathCheck.resolved, "utf8");
  const statements = splitSqlStatements(fileText);
  if (statements.length === 0) {
    return toolError(
      "schema_path contains no SQL statements after stripping comments.",
      { code: "SCHEMA_PATH_EMPTY" },
    );
  }

  const tempDb = newTempDbName();
  const pool = getPool(scratchConnection);
  const queryTimeout = getQueryTimeout(scratchConnection);
  const worker = await pool.getConnection();

  // Track whether the CREATE DATABASE succeeded so the cleanup branch
  // only drops what it actually created. The finally block runs even
  // when the create itself fails.
  let created = false;

  try {
    await worker.query(`CREATE DATABASE ${escapeId(tempDb)}`);
    created = true;
    await worker.query(`USE ${escapeId(tempDb)}`);

    for (const [i, stmt] of statements.entries()) {
      try {
        await worker.query({ sql: stmt, timeout: queryTimeout });
      } catch (err) {
        // Include the failing statement (truncated) in the error so an
        // operator can find the line at fault without re-reading the
        // file. The first 240 chars almost always cover the header of
        // a CREATE TABLE / CREATE VIEW.
        const head = stmt.slice(0, 240).replace(/\s+/g, " ");
        const msg = err instanceof Error ? err.message : String(err);
        return toolError(
          `Failed to apply statement ${i + 1} of ${statements.length} to the temp database.`,
          {
            code: "SCHEMA_LOAD_FAILED",
            hint: `Statement head: ${head} … — MySQL said: ${msg}`,
          },
        );
      }
    }

    // Now the temp DB looks like what the file describes. Hand off to
    // the shared comparison engine — same code path compare_schemas
    // uses against two live databases.
    return await runSchemaComparison({
      sourceConnection: scratchConnection,
      sourceDatabase: tempDb,
      targetConnection: liveConnection,
      targetDatabase: live.db,
      tableFilter: tables,
      scope,
      summaryOnly,
      extra,
      // Label the source as the file path the operator passed in.
      // The temp DB / scratch connection are scaffolding the agent
      // shouldn't have to reason about.
      sourceLabel: `file:${pathCheck.resolved}`,
    });
  } finally {
    if (created) {
      try {
        await worker.query(`DROP DATABASE ${escapeId(tempDb)}`);
      } catch (err) {
        // Log but don't throw — the comparison may have succeeded; an
        // orphaned temp DB is a leak but not a correctness issue.
        log("warn", "compare_schema_file: failed to drop temp DB", {
          connection: scratchConnection,
          tempDb,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    worker.release();
  }
}

// ── registration ───────────────────────────────────────────────────

export function registerCompareSchemaFileTool(server: McpServer) {
  server.registerTool(
    "compare_schema_file",
    {
      title: "Compare DB against schema.sql",
      description:
        "Diff a checked-in `.sql` schema file against a live database. " +
        "Loads the file into a temp database on a writable scratch connection, " +
        "delegates to the same engine compare_schemas uses, and drops the temp DB. " +
        "Intended for CI drift detection against a source-of-truth schema file.",
      inputSchema: {
        live_connection: z
          .string()
          .describe("Connection to check for drift against the file."),
        live_database: z
          .string()
          .optional()
          .describe(
            "Database on live_connection. Uses the connection's active db if omitted.",
          ),
        scratch_connection: z
          .string()
          .describe(
            "Writable connection where the schema file is loaded into a temp DB. Must be configured with readonly: false.",
          ),
        schema_path: z
          .string()
          .describe(
            "Filesystem path to the `.sql` file (e.g. checked-in `db/schema.sql`). Relative paths resolve against the server's cwd.",
          ),
        tables: z
          .array(z.string())
          .optional()
          .describe(
            "Restrict comparison to these table names. Same semantics as compare_schemas.",
          ),
        scope: z
          .array(z.enum(SCOPES))
          .optional()
          .describe(
            `Which aspects to compare. Default: all (${SCOPES.join(", ")}).`,
          ),
        summaryOnly: z
          .boolean()
          .optional()
          .describe(
            "Skip per-table detail rendering in markdown. structuredContent is unaffected.",
          ),
      },
      annotations: {
        // From the agent's perspective the *result* is read-only — a
        // diff. Internally we CREATE and DROP a temp DB on the scratch
        // connection, but that's scaffolding the agent doesn't see and
        // can't break. Mark read-only so clients don't gate confirmation
        // on every CI invocation.
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    toolHandler<CompareSchemaFileArgs>(
      "compare_schema_file",
      (input, callExtra) => handleCompareSchemaFile(input, callExtra),
    ),
  );
}

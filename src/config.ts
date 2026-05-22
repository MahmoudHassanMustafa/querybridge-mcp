import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { expandTilde } from "./paths.js";
import { log } from "./log.js";
import { AppConfigSchema, formatZodError } from "./schema.js";
import type { AppConfig } from "./schema.js";

/**
 * Load configuration from either:
 *  1. QUERYBRIDGE_MCP_CONFIG env var pointing to a JSON file
 *  2. QUERYBRIDGE_MCP_CONFIG_JSON env var containing inline JSON
 *  3. Individual env vars for a single connection (MYSQL_HOST, etc.)
 *
 * Every path produces the same raw object shape and is validated against
 * the same Zod schema, so default-handling and field validation live in
 * exactly one place.
 *
 * The legacy MYSQL_MCP_CONFIG / MYSQL_MCP_CONFIG_JSON names are still
 * accepted as a fallback and will log a deprecation warning.
 */
export function loadConfig(): AppConfig {
  // Option 1: Config file path
  const configPath = readEnvWithFallback(
    "QUERYBRIDGE_MCP_CONFIG",
    "MYSQL_MCP_CONFIG",
  );
  if (configPath) {
    const raw = readFileSync(resolve(expandTilde(configPath)), "utf-8");
    return validate(JSON.parse(raw), `file ${configPath}`);
  }

  // Option 2: Inline JSON
  const configJson = readEnvWithFallback(
    "QUERYBRIDGE_MCP_CONFIG_JSON",
    "MYSQL_MCP_CONFIG_JSON",
  );
  if (configJson) {
    return validate(JSON.parse(configJson), "inline JSON");
  }

  // Option 3: Single connection from env vars
  const host = process.env.MYSQL_HOST;
  if (!host) {
    throw new Error(
      "No configuration found. Set QUERYBRIDGE_MCP_CONFIG (file path), " +
        "QUERYBRIDGE_MCP_CONFIG_JSON (inline JSON), or MYSQL_HOST + related env vars.",
    );
  }

  return validate(envVarConfig(host), "env vars");
}

function validate(raw: unknown, source: string): AppConfig {
  try {
    return AppConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(
        `Invalid configuration from ${source}:\n${formatZodError(err)}`,
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Build the raw config object from the single-connection env-var protocol.
 * Defaults that differ from the schema (e.g. user defaults to "root" here,
 * but is required in the JSON path) live here, not in the schema.
 */
function envVarConfig(host: string): unknown {
  const conn: Record<string, unknown> = {
    name: process.env.MYSQL_CONNECTION_NAME || "default",
    host,
    port: process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT, 10) : 3306,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    readonly:
      process.env.MYSQL_READONLY !== undefined
        ? process.env.MYSQL_READONLY !== "false"
        : true,
    queryTimeout: process.env.MYSQL_QUERY_TIMEOUT
      ? parseInt(process.env.MYSQL_QUERY_TIMEOUT, 10)
      : undefined,
  };

  if (process.env.SSH_HOST) {
    conn.ssh = {
      host: process.env.SSH_HOST,
      port: process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22,
      username: process.env.SSH_USER || process.env.SSH_USERNAME || "root",
      password: process.env.SSH_PASSWORD,
      privateKeyPath: process.env.SSH_PRIVATE_KEY_PATH,
      passphrase: process.env.SSH_PASSPHRASE,
      hostFingerprint: process.env.SSH_HOST_FINGERPRINT,
      keepaliveInterval: process.env.SSH_KEEPALIVE_INTERVAL
        ? parseInt(process.env.SSH_KEEPALIVE_INTERVAL, 10)
        : undefined,
      keepaliveCountMax: process.env.SSH_KEEPALIVE_COUNT_MAX
        ? parseInt(process.env.SSH_KEEPALIVE_COUNT_MAX, 10)
        : undefined,
    };
  }

  return { connections: [conn] };
}

function readEnvWithFallback(
  current: string,
  legacy: string,
): string | undefined {
  const fromCurrent = process.env[current];
  if (fromCurrent) return fromCurrent;
  const fromLegacy = process.env[legacy];
  if (fromLegacy) {
    log(
      "warn",
      `${legacy} is deprecated, rename it to ${current}. Support will be removed in a future release.`,
    );
    return fromLegacy;
  }
  return undefined;
}

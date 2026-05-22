#!/usr/bin/env node

import { createRequire } from "node:module";
import type { Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { initConnection, closeAll } from "../connection.js";
import { registerTools } from "../tools/index.js";
import { registerResources } from "../resources.js";
import { registerPrompts } from "../prompts.js";
import { log, setLogSink, markLogSinkConnected } from "../log.js";
import { startHttpTransport } from "./http.js";

// Read version at runtime so it stays in sync with package.json (Changesets
// only bumps package.json, not arbitrary string literals in source).
const pkg = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};
const VERSION = pkg.version;

// Handle --version / -v before doing any work. Lets `querybridge-mcp-server
// --version` succeed without a configured database. stdout direct write
// (no console.log) because the no-console lint rule reserves console.* for
// emergencies — stdout normally belongs to the MCP JSON-RPC transport.
if (process.argv.slice(2).some((a) => a === "--version" || a === "-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

// Stay alive on background errors. A single unhandled rejection (e.g. a
// dropped SSH tunnel emitting late, or a pool connection dying between
// tool calls) would otherwise kill the MCP process and Claude Code cannot
// respawn a stdio server mid-session.
process.on("uncaughtException", (err) => {
  log("error", "uncaughtException", {
    error: err.message,
    stack: err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  log("error", "unhandledRejection", {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

/**
 * Tiny CLI arg parser supporting both `--key=value` and `--key value`
 * forms. Boolean flags (`--no-auth`) become `true`. Unknown args are
 * ignored — startup remains usable even if a future operator passes a
 * flag we don't yet recognise.
 */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    if (a.includes("=")) {
      const eq = a.indexOf("=");
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const transport = (args.transport as string) ?? "stdio";

  const config = loadConfig();

  const server = new McpServer(
    {
      name: "querybridge-mcp",
      version: VERSION,
    },
    {
      // Advertise the `logging` capability so clients know they can
      // expect notifications/message and may issue logging/setLevel.
      capabilities: { logging: {} },
    },
  );

  // Route log() calls through the server as MCP log notifications too.
  // The sink is invoked only after the transport is connected (below).
  setLogSink({
    sendLoggingMessage: (params) => server.server.sendLoggingMessage(params),
  });

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  // Initialize all database connections (with SSH tunnels if configured)
  const errors: string[] = [];
  for (const conn of config.connections) {
    try {
      await initConnection(conn);
      log("info", "connected", { connection: conn.name });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", "connection failed", { connection: conn.name, error: msg });
      errors.push(`Failed to connect "${conn.name}": ${msg}`);
    }
  }

  if (
    errors.length === config.connections.length &&
    config.connections.length > 0
  ) {
    log(
      "error",
      "all connections failed; server will start but no queries will work",
    );
  }

  let httpServer: HttpServer | undefined;

  // Graceful shutdown — close HTTP first (lets in-flight requests finish),
  // then drain DB pools and SSH tunnels.
  const shutdown = async (): Promise<void> => {
    const srv = httpServer;
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    await closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (transport === "http") {
    // Default to loopback so a naive launch doesn't expose anything.
    // External binding requires explicit --host and --allowed-hosts.
    const port = parseInt(String(args.port ?? "8080"), 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid --port: ${args.port}`);
    }
    const host = (args.host as string) ?? "127.0.0.1";
    const path = (args.path as string) ?? "/mcp";
    const allowedHosts = parseAllowedHosts(args["allowed-hosts"]);
    const noAuth = args["no-auth"] === true;
    const token = process.env.QUERYBRIDGE_MCP_HTTP_TOKEN || undefined;
    const corsOrigin = (args["cors-origin"] as string) || undefined;

    httpServer = await startHttpTransport(server, {
      port,
      host,
      path,
      token,
      noAuth,
      allowedHosts,
      corsOrigin,
    });
    // Sink can flush from this point on — the HTTP transport is
    // connected and the SDK will route notifications/* to whichever
    // session is currently subscribed.
    markLogSinkConnected();
    return;
  }

  if (transport !== "stdio") {
    throw new Error(
      `Unknown --transport: ${transport}. Use "stdio" (default) or "http".`,
    );
  }

  // Start MCP transport (stdio)
  const stdio = new StdioServerTransport();
  await server.connect(stdio);
  // Now that the transport is connected, the log sink can safely forward
  // notifications. Any log() before this point only writes to stderr.
  markLogSinkConnected();
  log("info", "server running on stdio");
}

/**
 * Parse a comma-separated --allowed-hosts value. Returns an empty array
 * when the flag wasn't passed.
 */
function parseAllowedHosts(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

main().catch((err) => {
  log("error", "fatal", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

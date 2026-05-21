#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { initConnection, closeAll } from "./connection.js";
import { registerTools } from "./tools/index.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { log, setLogSink, markLogSinkConnected } from "./helpers.js";

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

async function main() {
  const config = loadConfig();

  const server = new McpServer(
    {
      name: "querybridge-mcp",
      version: "0.4.0",
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

  // Graceful shutdown
  const shutdown = async () => {
    await closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Now that the transport is connected, the log sink can safely forward
  // notifications. Any log() before this point only writes to stderr.
  markLogSinkConnected();
  log("info", "server running on stdio");
}

main().catch((err) => {
  log("error", "fatal", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

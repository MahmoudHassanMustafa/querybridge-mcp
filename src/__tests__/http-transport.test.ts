/**
 * Tests for the Streamable HTTP transport.
 *
 * Two surfaces:
 *   - `isValidBearer` — pure function, unit-tested directly. Critical
 *     because it's the security boundary; timing attacks are the most
 *     common bug here.
 *   - End-to-end: spin up `startHttpTransport` on an ephemeral port,
 *     send a real MCP initialize, verify the server returns a session
 *     id + protocolVersion. Covers auth, path routing, body parsing,
 *     the SDK transport wiring — all in one path.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { startHttpTransport, isValidBearer } from "../server/http.js";

// ── isValidBearer ───────────────────────────────────────────────────

describe("isValidBearer", () => {
  it("accepts the correct Bearer token", () => {
    expect(isValidBearer("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("rejects a missing scheme", () => {
    expect(isValidBearer("s3cret", "s3cret")).toBe(false);
  });

  it("rejects the wrong scheme (Basic, Token, etc.)", () => {
    expect(isValidBearer("Basic s3cret", "s3cret")).toBe(false);
    expect(isValidBearer("Token s3cret", "s3cret")).toBe(false);
  });

  it("rejects a wrong-but-same-length token (constant-time path)", () => {
    expect(isValidBearer("Bearer aaaaaa", "bbbbbb")).toBe(false);
  });

  it("rejects a wrong-length token (short-circuit path)", () => {
    expect(isValidBearer("Bearer abc", "longer-token")).toBe(false);
    expect(isValidBearer("Bearer way-too-long-token", "abc")).toBe(false);
  });

  it("is case-insensitive on the `Bearer` scheme name (RFC 6750)", () => {
    expect(isValidBearer("bearer s3cret", "s3cret")).toBe(true);
    expect(isValidBearer("BEARER s3cret", "s3cret")).toBe(true);
  });

  it("trims a trailing whitespace from the provided token", () => {
    // Some HTTP clients tack a trailing space on; we trim to match.
    expect(isValidBearer("Bearer s3cret  ", "s3cret")).toBe(true);
  });

  it("rejects an empty token entirely", () => {
    expect(isValidBearer("Bearer ", "s3cret")).toBe(false);
  });
});

// ── End-to-end via a live HTTP server ───────────────────────────────

describe("startHttpTransport — end-to-end", () => {
  const TOKEN = "test-token-eeeeeeee";
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    // Use a no-op MCP server (no tools registered) — we only verify
    // the HTTP plumbing here, the protocol layer is the SDK's
    // responsibility and already covered by its own tests.
    const mcp = new McpServer({ name: "test", version: "0.0.0" });
    server = await startHttpTransport(mcp, {
      port: 0, // ephemeral
      host: "127.0.0.1",
      path: "/mcp",
      token: TOKEN,
      noAuth: false,
      allowedHosts: [],
      corsOrigin: undefined,
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    // SSE streams can keep sockets alive past `close()`; force-close
    // them so the test process exits promptly.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function url(path = "/mcp"): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  it("rejects requests without an Authorization header (401)", async () => {
    const res = await fetch(url(), { method: "GET" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects requests with the wrong token (401)", async () => {
    const res = await fetch(url(), {
      method: "GET",
      headers: { authorization: "Bearer not-the-real-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown paths even with a valid token", async () => {
    const res = await fetch(url("/elsewhere"), {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it("completes a real MCP initialize handshake", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    // Stateful mode emits a session id; the SDK should always set this.
    expect(res.headers.get("mcp-session-id")).toMatch(/^[a-f0-9-]{36}$/i);

    const body = await res.text();
    // SDK responds in SSE format by default for initialize:
    // `event: message\ndata: <json>\n\n`. We just look for the JSON line.
    const dataLine = body
      .split("\n")
      .find((l) => l.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice("data: ".length));
    expect(payload.result.serverInfo.name).toBe("test");
    expect(payload.result.protocolVersion).toBe("2024-11-05");
  });

  it("rejects oversized bodies (413)", async () => {
    // The transport reads the body before validating; pre-cap is in
    // our middleware. Default cap is 4MB; send 5MB of nonsense.
    const huge = "x".repeat(5 * 1024 * 1024);
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: huge,
    });
    expect(res.status).toBe(413);
  });

  it("rejects malformed JSON (400)", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "not-json-at-all",
    });
    expect(res.status).toBe(400);
  });
});

// ── Startup-time refusal modes ──────────────────────────────────────

describe("startHttpTransport — startup guards", () => {
  it("refuses to start without a token unless --no-auth is set", async () => {
    const mcp = new McpServer({ name: "test", version: "0.0.0" });
    await expect(
      startHttpTransport(mcp, {
        port: 0,
        host: "127.0.0.1",
        path: "/mcp",
        token: undefined,
        noAuth: false,
        allowedHosts: [],
        corsOrigin: undefined,
      }),
    ).rejects.toThrow(/QUERYBRIDGE_MCP_HTTP_TOKEN/);
  });

  it("refuses to bind 0.0.0.0 without --allowed-hosts (DNS rebinding guard)", async () => {
    const mcp = new McpServer({ name: "test", version: "0.0.0" });
    await expect(
      startHttpTransport(mcp, {
        port: 0,
        host: "0.0.0.0",
        path: "/mcp",
        token: "x",
        noAuth: false,
        allowedHosts: [],
        corsOrigin: undefined,
      }),
    ).rejects.toThrow(/allowed-hosts/);
  });

  it("starts with --no-auth on loopback (operator opt-out)", async () => {
    const mcp = new McpServer({ name: "test", version: "0.0.0" });
    const server = await startHttpTransport(mcp, {
      port: 0,
      host: "127.0.0.1",
      path: "/mcp",
      token: undefined,
      noAuth: true,
      allowedHosts: [],
      corsOrigin: undefined,
    });
    expect(server.listening).toBe(true);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

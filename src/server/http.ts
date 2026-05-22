/**
 * Streamable HTTP transport for querybridge-mcp.
 *
 * Wraps Node's built-in `http` module around the SDK's
 * `StreamableHTTPServerTransport`. Single persistent transport in
 * stateful mode (one `sessionIdGenerator: () => randomUUID()` instance),
 * because server-initiated notifications — log forwarding via
 * `notifications/message` and tool progress via
 * `notifications/progress` — require a session to flow through.
 *
 * Security defaults (in order of operator surprise cost):
 *
 *   - **Bearer auth required by default**. The operator sets
 *     `QUERYBRIDGE_MCP_HTTP_TOKEN`; the server refuses to start without
 *     it. Use `--no-auth` to opt out (logged as a warning every
 *     startup so it's never accidental).
 *   - **Loopback by default** (`127.0.0.1`). External exposure requires
 *     `--host=0.0.0.0` and triggers Host-header validation against
 *     `allowedHosts` so a DNS-rebinding attack from a browser can't
 *     reach the local server.
 *   - **No CORS by default**. The MCP spec is built around same-origin
 *     RPC; browsers reaching MCP servers cross-origin are unusual and
 *     should be opt-in via `--cors-origin=URL`.
 *
 * No new runtime dependencies. The `http`, `crypto`, and `url` modules
 * are stdlib; `StreamableHTTPServerTransport` ships with the SDK.
 */
import http from "node:http";
import crypto from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { log } from "../log.js";

/** Caps the JSON body size we'll accept on a single POST. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpTransportOptions {
  port: number;
  host: string;
  /** Path the transport serves on. Default `/mcp`. */
  path: string;
  /**
   * Bearer token clients must present in `Authorization: Bearer <token>`.
   * `undefined` means auth is disabled — refused unless `noAuth` is also
   * true. Two-step opt-out is deliberate: operators shouldn't drop auth
   * by typoing the env var name.
   */
  token: string | undefined;
  /** Operator-explicit acknowledgement that they want no auth. */
  noAuth: boolean;
  /**
   * Host header values to accept. When the server binds outside
   * loopback we require this to prevent DNS-rebinding attacks. Empty
   * array = no validation (only safe on loopback bindings).
   */
  allowedHosts: string[];
  /**
   * Permissive CORS origin. Most MCP clients don't need it; expose
   * this only when a browser-based client needs cross-origin access.
   */
  corsOrigin: string | undefined;
}

/**
 * Start the HTTP transport listening on the given port/host. Returns
 * the underlying http.Server so callers can manage shutdown.
 */
export async function startHttpTransport(
  mcpServer: McpServer,
  opts: HttpTransportOptions,
): Promise<HttpServer> {
  // Refuse to start without a token unless the operator opted out
  // explicitly. The two-key pattern (token absent AND --no-auth) keeps
  // a typo in the env var name from silently disabling auth.
  if (!opts.token && !opts.noAuth) {
    throw new Error(
      "HTTP transport requires QUERYBRIDGE_MCP_HTTP_TOKEN. " +
        "Set it, or pass --no-auth to opt out (loopback-only deployments).",
    );
  }
  if (opts.noAuth) {
    log("warn", "HTTP auth disabled by --no-auth", {
      host: opts.host,
      port: opts.port,
    });
  }
  // External exposure without host validation is a known DNS-rebinding
  // surface. Refuse before listen() rather than after the first attack.
  if (opts.host === "0.0.0.0" && opts.allowedHosts.length === 0) {
    throw new Error(
      "Binding to 0.0.0.0 without --allowed-hosts. Pass --allowed-hosts " +
        "with the public hostname(s) clients will use to reach this server.",
    );
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  // SDK uses get/set accessors for onclose/onerror/onmessage on this
  // class, which makes them required-with-undefined under
  // exactOptionalPropertyTypes — but the Transport interface declares
  // them optional. Runtime behavior is identical; the type mismatch is
  // purely a strict-optionals artifact.
  await mcpServer.connect(transport as unknown as Transport);

  const httpServer = http.createServer((req, res) => {
    handleRequest(transport, opts, req, res).catch((err) => {
      log("error", "http handler failed", {
        method: req.method,
        url: req.url,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain");
        res.end("Internal server error");
      } else {
        res.destroy();
      }
    });
  });

  return await new Promise<HttpServer>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off("error", reject);
      log("info", "http transport listening", {
        host: opts.host,
        port: opts.port,
        path: opts.path,
        auth: opts.token ? "bearer" : "disabled",
      });
      resolve(httpServer);
    });
  });
}

async function handleRequest(
  transport: StreamableHTTPServerTransport,
  opts: HttpTransportOptions,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // ── CORS preflight ────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    if (opts.corsOrigin) {
      res.setHeader("access-control-allow-origin", opts.corsOrigin);
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE");
      // mcp-session-id is the SDK's session header; the rest are standard.
      res.setHeader(
        "access-control-allow-headers",
        "content-type, authorization, mcp-session-id, last-event-id",
      );
      res.setHeader("access-control-expose-headers", "mcp-session-id");
      res.setHeader("access-control-max-age", "86400");
    }
    res.statusCode = 204;
    res.end();
    return;
  }
  if (opts.corsOrigin) {
    res.setHeader("access-control-allow-origin", opts.corsOrigin);
    res.setHeader("access-control-expose-headers", "mcp-session-id");
  }

  // ── Host header validation (DNS rebinding) ───────────────────
  if (opts.allowedHosts.length > 0) {
    const host = (req.headers.host ?? "").toLowerCase();
    // Trim a trailing :port so "example.com:8080" matches "example.com".
    const hostName = host.replace(/:\d+$/, "");
    if (!opts.allowedHosts.includes(hostName) && !opts.allowedHosts.includes(host)) {
      log("warn", "host validation failed", {
        host: req.headers.host,
        allowedHosts: opts.allowedHosts,
      });
      res.statusCode = 421;
      res.setHeader("content-type", "text/plain");
      res.end("Misdirected request");
      return;
    }
  }

  // ── Path check ───────────────────────────────────────────────
  // req.url includes any query string; strip it before comparing.
  const path = req.url?.split("?", 1)[0] ?? "/";
  if (path !== opts.path) {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain");
    res.end("Not found");
    return;
  }

  // ── Bearer auth ──────────────────────────────────────────────
  if (opts.token) {
    const authz = req.headers.authorization;
    if (!authz || !isValidBearer(authz, opts.token)) {
      res.statusCode = 401;
      // RFC 6750 §3 — the WWW-Authenticate challenge.
      res.setHeader("www-authenticate", 'Bearer realm="querybridge-mcp"');
      res.setHeader("content-type", "text/plain");
      res.end("Unauthorized");
      return;
    }
  }

  // ── Body parsing for POST ────────────────────────────────────
  // The SDK can read the body itself via the Web Standards adapter,
  // but pre-parsing here lets us enforce a size cap before allocating
  // the full buffer downstream.
  let parsedBody: unknown = undefined;
  if (req.method === "POST") {
    try {
      parsedBody = await readJsonBody(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = msg.includes("too large") ? 413 : 400;
      res.setHeader("content-type", "text/plain");
      res.end(msg);
      return;
    }
  }

  // ── Delegate to SDK transport ────────────────────────────────
  await transport.handleRequest(req, res, parsedBody);
}

/**
 * Constant-time bearer-token comparison. Returns false for header shapes
 * we don't recognise rather than throwing — the caller treats false as
 * 401 either way, and we don't want timing differences to distinguish
 * "no header" from "wrong token".
 */
export function isValidBearer(authHeader: string, expected: string): boolean {
  if (!authHeader.toLowerCase().startsWith("bearer ")) return false;
  const provided = authHeader.slice("bearer ".length).trim();
  // Length compare is fine to short-circuit on — token length isn't
  // secret. timingSafeEqual would throw on length mismatch anyway.
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(provided, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}

/**
 * Read a request body up to MAX_BODY_BYTES and JSON.parse it. Throws
 * on oversize bodies (caller maps to 413) or malformed JSON (caller
 * maps to 400).
 */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Drain and reject. Stopping mid-stream would leak a TCP socket.
      req.resume();
      throw new Error("request body too large");
    }
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `malformed JSON body: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

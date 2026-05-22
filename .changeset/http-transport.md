---
"querybridge-mcp": minor
---

**Streamable HTTP transport.** `querybridge-mcp-server` now supports two transports: the existing stdio (default, what Claude Code uses) and HTTP (for Cursor, n8n, hosted agents, browser-based clients). Implements the [MCP Streamable HTTP spec](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports) with stateful sessions, so log forwarding (`notifications/message`) and progress (`notifications/progress`) work end-to-end over HTTP.

**Quick start:**

```bash
export QUERYBRIDGE_MCP_HTTP_TOKEN=$(openssl rand -base64 32)
querybridge-mcp-server --transport=http --port=8080
```

```json
{
  "mcpServers": {
    "querybridge-mcp": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": { "Authorization": "Bearer <YOUR_TOKEN>" }
    }
  }
}
```

**Flags:** `--transport=stdio|http`, `--port`, `--host` (default `127.0.0.1`), `--path` (default `/mcp`), `--allowed-hosts`, `--no-auth`, `--cors-origin`.

**Security defaults:**

- **Bearer auth required.** `QUERYBRIDGE_MCP_HTTP_TOKEN` env var; server refuses to start otherwise. Two-key opt-out (no token AND `--no-auth`) prevents accidentally disabling auth via env-var typo.
- **Loopback by default** (`127.0.0.1`). External binding requires `--allowed-hosts` for DNS-rebinding protection.
- **No CORS by default** — opt in per-origin with `--cors-origin`.
- **Body size capped at 4MB.**
- **Constant-time token comparison.**
- **All security guarantees of the stdio transport still apply** — read-only enforcement, LOAD INFILE block, KILL QUERY cancellation, error sanitization.

**Container:** the Docker image now `EXPOSE`s 8080. Usage example in the Dockerfile and README.

**Tests:** 17 new tests (bearer validation, startup guards, end-to-end MCP handshake against a live local server). Total now 349 unit + 15 integration.

**No new runtime dependencies.** The transport uses Node's built-in `http` module + the SDK's `StreamableHTTPServerTransport`.

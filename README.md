# querybridge-mcp

[![CI](https://github.com/MahmoudHassanMustafa/querybridge-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/MahmoudHassanMustafa/querybridge-mcp/actions/workflows/ci.yml)

A Model Context Protocol (MCP) server that connects Claude Code to MySQL databases. Supports SSH tunnels, SSL/TLS, and multiple simultaneous connections.

## Features

- **28 tools** for schema introspection, querying, ERD generation, programmability, operator admin, and cross-database diffing
- **2 MCP resources** for browsable schema access
- **4 MCP prompts** for guided database workflows
- **SSH tunnel support** with password or private key authentication
- **SSL/TLS support** for direct encrypted connections
- **Multi-database** connections with independent configs
- **Read-only by default** with per-connection write control
- **CLI** for managing connections without editing JSON

## Installation

Install globally from npm:

```bash
npm install -g querybridge-mcp
```

Or run on demand without installing:

```bash
npx querybridge-mcp <command>
npx querybridge-mcp-server   # starts the MCP server
```

Or pull the Docker image (no Node install needed):

```bash
docker pull ghcr.io/mahmoudhassanmustafa/querybridge-mcp:latest
```

Check the version on any of the above:

```bash
querybridge-mcp --version       # or: querybridge-mcp-server --version
```

### Register with Claude Code

```bash
claude mcp add querybridge-mcp -e QUERYBRIDGE_MCP_CONFIG=/path/to/config.json -- querybridge-mcp-server
```

Or manually in `~/.claude.json`:

```json
{
  "mcpServers": {
    "querybridge-mcp": {
      "type": "stdio",
      "command": "querybridge-mcp-server",
      "env": {
        "QUERYBRIDGE_MCP_CONFIG": "/path/to/config.json"
      }
    }
  }
}
```

If `querybridge-mcp-server` isn't on your PATH (e.g. not installed globally), swap `command` for `npx` with `"args": ["-y", "querybridge-mcp-server"]`.

### Register with Claude Code via Docker

For environments where Node/pnpm aren't installed, run the server from a published image. Mount your config read-only and let the container handle the rest:

```bash
claude mcp add querybridge-mcp -- \
  docker run --rm -i \
  -v /path/to/config.json:/config/config.json:ro \
  -e QUERYBRIDGE_MCP_CONFIG=/config/config.json \
  ghcr.io/mahmoudhassanmustafa/querybridge-mcp:latest
```

Or manually in `~/.claude.json`:

```json
{
  "mcpServers": {
    "querybridge-mcp": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-v", "/path/to/config.json:/config/config.json:ro",
        "-e", "QUERYBRIDGE_MCP_CONFIG=/config/config.json",
        "ghcr.io/mahmoudhassanmustafa/querybridge-mcp:latest"
      ]
    }
  }
}
```

Notes:
- `--rm -i` is required — `-i` wires stdio (the MCP transport); `--rm` cleans up the container after the client disconnects.
- For SSH tunnels you also need to bind-mount the private key: add `-v ~/.ssh/id_ed25519:/keys/id_ed25519:ro` and reference `/keys/id_ed25519` in your config's `ssh.privateKeyPath`.
- Pin to a specific version (`:v0.4.1`) for reproducibility; `:latest` follows the current release.
- The image runs as a non-root `node` user. Mounts must be readable by UID 1000.
- Multi-arch: `linux/amd64` + `linux/arm64`. Apple Silicon and Linux servers work out of the box.

## CLI

The CLI manages your `config.json` without editing it by hand. After `npm install -g querybridge-mcp`, the `querybridge-mcp` command is on your PATH.

### Commands

| Command | Description |
|---------|-------------|
| `querybridge-mcp list` | List all configured connections |
| `querybridge-mcp add [name]` | Add a new connection (interactive) |
| `querybridge-mcp remove <name>` | Remove a connection |
| `querybridge-mcp test [name]` | Test one or all connections |
| `querybridge-mcp init` | Create an empty config file |

### Examples

```bash
# Create config and add first connection interactively
querybridge-mcp init
querybridge-mcp add production

# Test all connections
querybridge-mcp test

# Test a specific connection
querybridge-mcp test production

# Remove a connection
querybridge-mcp remove staging
```

Set `QUERYBRIDGE_MCP_CONFIG` in your shell profile so the CLI always finds your config:

```bash
export QUERYBRIDGE_MCP_CONFIG=~/.config/querybridge-mcp/config.json
```

## Configuration

Three ways to configure, in order of precedence:

### 1. Config file (recommended)

Set `QUERYBRIDGE_MCP_CONFIG` to a JSON file path, or use the CLI to build one.

```json
{
  "connections": [
    {
      "name": "local",
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "secret",
      "database": "myapp",
      "readonly": true,
      "queryTimeout": 30000
    }
  ]
}
```

### 2. Inline JSON

Set `QUERYBRIDGE_MCP_CONFIG_JSON` to a JSON string:

```bash
QUERYBRIDGE_MCP_CONFIG_JSON='{"connections":[{"name":"dev","host":"localhost","user":"root","password":"secret","database":"myapp"}]}'
```

### 3. Environment variables (single connection)

```bash
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=secret
MYSQL_DATABASE=myapp
MYSQL_READONLY=true
MYSQL_QUERY_TIMEOUT=30000
MYSQL_CONNECTION_NAME=default
```

### Connection options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Unique connection identifier |
| `host` | string | required | MySQL hostname or IP |
| `port` | number | `3306` | MySQL port |
| `user` | string | required | MySQL username |
| `password` | string | | MySQL password |
| `database` | string | | Default database/schema |
| `readonly` | boolean | `true` | Block write operations |
| `queryTimeout` | number | `30000` | Query timeout in milliseconds |
| `poolSize` | number | `5` | mysql2 connection-pool size |
| `ssh` | object | | SSH tunnel configuration |
| `ssl` | object or `true` | | SSL/TLS configuration |

### Secrets indirection

`password`, `ssh.password`, and `ssh.passphrase` accept either a plain
string OR an indirection object so credentials don't need to live in the
config file:

```json
{
  "password": { "env": "PROD_DB_PASSWORD" },
  "ssh": {
    "host": "bastion.example.com",
    "username": "deploy",
    "passphrase": { "file": "~/.secrets/ssh-passphrase" }
  }
}
```

| Form | Behavior |
|------|----------|
| `"secret"` | Plain string (back-compat, fine for dev) |
| `{ "env": "VAR_NAME" }` | Read from `process.env.VAR_NAME` at startup. Errors if unset or empty. |
| `{ "file": "/path/to/file" }` | Read file contents (tilde-expanded, trailing whitespace trimmed). |

Resolution happens once at config load; downstream code only sees the
resolved string.

### SSH tunnel

Tunnel MySQL traffic through an SSH bastion host. Supports password and private key authentication.

```json
{
  "name": "production",
  "host": "rds-internal.example.com",
  "port": 3306,
  "user": "app",
  "password": "secret",
  "database": "prod",
  "readonly": true,
  "ssh": {
    "host": "bastion.example.com",
    "port": 22,
    "username": "deploy",
    "privateKeyPath": "~/.ssh/id_rsa",
    "passphrase": "optional",
    "hostFingerprint": "SHA256:AAAA...=="
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `host` | string | required | SSH server hostname |
| `port` | number | `22` | SSH port |
| `username` | string | required | SSH username |
| `password` | string | | SSH password |
| `privateKeyPath` | string | | Path to private key (supports `~/`) |
| `passphrase` | string | | Private key passphrase |
| `hostFingerprint` | string | | Pinned SHA256 fingerprint of the SSH server's host key (format: `ssh-keygen -lf`). When unset, the server logs a warning and accepts any host key. Get it with `ssh-keyscan <host> \| ssh-keygen -lf -`. |

### SSL/TLS

For direct encrypted connections (without SSH):

```json
{
  "ssl": true
}
```

Or with custom certificates:

```json
{
  "ssl": {
    "ca": "~/.ssl/ca.pem",
    "cert": "~/.ssl/client-cert.pem",
    "key": "~/.ssl/client-key.pem",
    "rejectUnauthorized": true
  }
}
```

## Tools

### Connection management

| Tool | Description |
|------|-------------|
| `list_connections` | List all connections with status, host, SSH/SSL indicators |
| `list_databases` | List all databases accessible on a connection |
| `use_database` | Switch the active database/schema for a connection |

### Schema introspection

| Tool | Description |
|------|-------------|
| `list_tables` | List tables with row counts and engine info |
| `list_views` | List views with definer, security type, updatability |
| `describe_table` | Show columns, indexes, and CREATE TABLE statement |
| `describe_view` | Show columns and CREATE VIEW DDL of a view |
| `get_ddl` | Get clean CREATE TABLE DDL |
| `get_view_ddl` | Get clean CREATE VIEW DDL (raw, not truncated) |
| `get_foreign_keys` | Show FK relationships with cascade rules |
| `get_indexes` | Show all indexes with duplicate detection |
| `search_columns` | Find columns by name pattern across all tables |

### Query execution

| Tool | Description |
|------|-------------|
| `execute_query` | Run SQL with parameterized values. Writes blocked on read-only connections |
| `explain_query` | Run EXPLAIN in TRADITIONAL, JSON, or TREE format |

### Data inspection

| Tool | Description |
|------|-------------|
| `get_table_stats` | Row counts, data/index sizes, timestamps |
| `sample_data` | Preview rows from a table (default: 5 rows) |

### Stored routines and programmability

| Tool | Description |
|------|-------------|
| `list_routines` | List stored procedures and functions |
| `get_routine_ddl` | Get full DDL for a procedure or function |
| `list_triggers` | List triggers, optionally filtered by table |
| `get_trigger_ddl` | Get full trigger definition |
| `list_events` | List scheduled events with status and timing |
| `get_event_ddl` | Get full event definition |

### Visualization

| Tool | Description |
|------|-------------|
| `generate_erd` | Generate a Mermaid ER diagram with tables, columns, PKs, FKs, and relationships |

### Operator / admin

| Tool | Description |
|------|-------------|
| `list_processes` | Show running connections + their current queries (filter by minimum duration) |
| `kill_query` | KILL QUERY (or KILL CONNECTION) by process ID. Gated: requires `readonly: false` |
| `get_unused_indexes` | Detect secondary indexes with zero reads in `performance_schema` and produce DROP statements |
| `get_charset_collation` | Show character set and collation at database, table, and column levels |

### Cross-database diffing

| Tool | Description |
|------|-------------|
| `compare_schemas` | Diff two databases (potentially across connections). Reports drift across **9 aspects**: tables, table attributes (engine/charset/**partitioning**), columns (incl. comments, generated cols), indexes (incl. MySQL 8 invisible indexes, functional indexes, prefix lengths), foreign keys, views, routines, triggers, events. SQL bodies are whitespace-normalized; int display widths are normalized for cross-version (5.7 ↔ 8.0+) sanity. Restrict with `tables` filter or `scope` for cheaper runs. `summaryOnly: true` keeps huge diffs in context budget. Emits MCP progress notifications per scope. Honors client-side cancellation. |

## Resources

MCP resources let Claude browse schema information without explicit tool calls.

| URI Pattern | Description |
|-------------|-------------|
| `mysql://{connection}/{database}/{table}/schema` | Table schema with columns and DDL |
| `mysql://{connection}/{database}/overview` | Database overview with all tables and row counts |

## Prompts

Pre-built prompt templates that guide Claude through multi-step database workflows.

| Prompt | Description |
|--------|-------------|
| `explore_database` | Discover tables, schemas, FKs, routines, triggers, events, and generate an ERD |
| `optimize_query` | Analyze a query with EXPLAIN, check indexes, suggest improvements |
| `find_data` | Search columns by pattern, sample tables, build a query |
| `audit_schema` | Check for missing PKs, redundant indexes, empty tables, catalog routines and triggers |

### Using prompts in Claude Code

Prompts appear in the MCP prompt list. Select one and provide the required arguments (connection name, database, etc.) to start a guided workflow.

## Safety

- **Read-only by default.** Write queries (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE) are blocked unless `"readonly": false` is set on the connection.
- **Server-side read-only enforcement.** Read-only pools also run `SET SESSION transaction_read_only = 1, sql_safe_updates = 1` on every connection, so even a parser bypass is rejected by MySQL itself.
- **LOAD DATA LOCAL INFILE disabled.** The `LOCAL_FILES` capability is dropped from the client handshake and the `infileStreamFactory` is hard-wired to throw — a malicious MySQL server cannot read files from the MCP host.
- **Parameterized queries.** The `execute_query` tool uses prepared statements with `?` placeholders to prevent SQL injection.
- **Result limits.** Unbounded SELECT queries are auto-limited to 1000 rows. Table output is additionally capped at 256KB with a truncation note; individual cell values are truncated at 120 characters.
- **Cancellable queries.** If the MCP client cancels a request, `execute_query` and `explain_query` issue `KILL QUERY` on a sibling connection so the in-flight statement is stopped at the server, not just abandoned by the client.
- **Tool annotations.** Every tool advertises MCP `readOnlyHint` / `destructiveHint` / `idempotentHint` so clients (and humans) can gate confirmation prompts appropriately.
- **Structured results.** Tools return both human-readable text AND `structuredContent` JSON, so clients that support the modern MCP spec can render rich tables instead of monospace ASCII.
- **Audit logging.** Every tool invocation is logged to stderr with the connection, elapsed ms, and pre-condition rejections — so operators can see exactly what the agent did. Logs are also forwarded to the MCP client via `notifications/message` (per spec) so connected clients see them inline.
- **Config file in .gitignore.** The `config.json` file containing credentials is excluded from version control.

## Project structure

```
querybridge-mcp/
  src/
    index.ts              Server entry point (MCP stdio transport)
    cli.ts                CLI entry point
    types.ts              TypeScript interfaces
    config.ts             Config loading (file, inline JSON, env vars)
    connection.ts         MySQL pool management + SSH tunneling
    helpers.ts            Shared utilities (formatting, escaping, errors)
    resources.ts          MCP resource templates
    prompts.ts            MCP prompt templates
    tools/
      index.ts            Tool registration barrel
      connection-tools.ts list_connections, list_databases, use_database
      schema-tools.ts     list_tables, describe_table, get_ddl, get_foreign_keys, get_indexes, search_columns, list_views, describe_view, get_view_ddl
      query-tools.ts      execute_query, explain_query
      data-tools.ts       sample_data, get_table_stats
      routines-tools.ts   list_routines, get_routine_ddl, list_triggers, get_trigger_ddl, list_events, get_event_ddl
      erd-tool.ts         generate_erd
      admin-tools.ts      list_processes, kill_query, get_unused_indexes, get_charset_collation
  dist/                   Compiled output
  config.json             Your connections (gitignored)
  config.example.json     Example configuration
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs add a [changeset](https://github.com/changesets/changesets) describing the user-visible effect; releases are automated.

## License

MIT

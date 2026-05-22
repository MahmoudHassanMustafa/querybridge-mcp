# Security Policy

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report them privately via
[GitHub's private vulnerability reporting](https://github.com/MahmoudHassanMustafa/querybridge-mcp/security/advisories/new).
Include:

- A description of the issue and its impact
- Steps to reproduce (a minimal repro helps)
- Any proof-of-concept code or config

You can expect an acknowledgement within a few days. Once the issue is
confirmed, a fix will be prepared and published as a patch release, with
credit to the reporter unless you request otherwise.

## Supported Versions

querybridge-mcp follows semantic versioning. Security fixes ship against:

| Version | Supported |
| ------- | --------- |
| 0.9.x   | ✅        |
| < 0.9   | ❌        |

When a new minor (0.10, 0.11, ...) lands, the previous minor stops receiving fixes unless an operator explicitly requests a backport. The `main` branch always reflects the next release.

## Security Posture

This server exposes a MySQL connection to an LLM — treat that as a
serious trust boundary. The project takes a defence-in-depth approach:

**Read-only by default.** Connections are read-only unless the config
explicitly sets `"readonly": false`. On read-only connections, only
`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, and `USE` are permitted.
Write operations, `SELECT INTO OUTFILE`/`DUMPFILE`, and `WITH … INSERT`
variants are rejected. SQL comments are stripped before the check so
they can't be used to hide writes.

**No multi-statement queries.** The MySQL driver is configured with
`multipleStatements: false`, so a single tool call cannot execute
semicolon-chained statements.

**Server-side read-only enforcement.** On every physical connection in
a `readonly: true` pool, the server runs
`SET SESSION transaction_read_only = 1, SESSION sql_safe_updates = 1`.
This is a belt-and-braces complement to the SQL-text whitelist: even if
the parser is ever fooled into letting a write through, MySQL itself
rejects it with `ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION`, and
unqualified `UPDATE`/`DELETE` statements (no indexed `WHERE`) are
refused with `ER_UPDATE_WITHOUT_KEY_IN_SAFE_MODE`.

**LOAD DATA LOCAL INFILE is disabled on every pool.** The MySQL client
flag `LOCAL_FILES` is dropped from the capability handshake, and the
`infileStreamFactory` is set to a function that throws. A malicious or
compromised MySQL server cannot use the well-known `LOCAL INFILE`
trick to read arbitrary files from the host running the MCP server.

**Parameterized queries.** Tools that accept user data (`execute_query`
with `params`, `sample_data`, `search_columns`) pass values as bound
parameters. Table and column names are escaped with MySQL identifier
quoting.

**SSH host key verification (opt-in).** When `ssh.hostFingerprint` is
set on a connection, the tunnel rejects mismatched server keys via a
`timingSafeEqual` SHA256 comparison. When absent, a warning is logged
on every connect so the MITM risk is visible to the operator.

**SSL/TLS.** Direct MySQL connections can use `ssl: true` (strict) or
a full `{ ca, cert, key, rejectUnauthorized }` object. Disabling
certificate validation logs a warning on every connect.

**Error sanitization.** Every tool handler is wrapped so MySQL errors
containing `'user'@'host'` patterns and internal IP addresses are
redacted before being returned to the MCP client (and thus to the LLM).
Operator-side logs on stderr retain the raw error for debugging.

**Output size caps.** Query results are bounded by both row count
(1000 rows per query, 500 formatted) and byte budget (256KB of
formatted output), so a single wide row or a runaway JSON column
cannot exhaust the model's context or cause upstream 500s.

**Minimal logging scope.** All logging goes to stderr only. The stdio
transport used by MCP reserves stdout for JSON-RPC; no tool result,
query, or credential is ever written to stdout or to a file.

## Security Considerations for Operators

- **Credentials.** Connection configs contain plaintext passwords and
  SSH private-key paths. Store the config file with `chmod 600` and
  never commit it.
- **Fingerprint pinning.** For any SSH tunnel, set
  `ssh.hostFingerprint` to the `SHA256:…` value from
  `ssh-keygen -lf <(ssh-keyscan -t ed25519 your-host)`. Without it,
  the tunnel is vulnerable to MITM.
- **Read-write access.** If you enable `"readonly": false` on a
  connection, you are handing the LLM the ability to issue
  `INSERT`/`UPDATE`/`DELETE`/`DROP`. Grant the MySQL user only the
  privileges it actually needs.
- **Network surface (stdio default).** With the default `--transport=stdio`,
  the MCP server does not open network ports. SSH tunnels bind to
  `127.0.0.1` on an ephemeral port and are not reachable from other hosts.
- **Network surface (HTTP transport).** With `--transport=http`, the
  server listens on a TCP port (loopback by default). Bearer-token
  authentication is required at the boundary; CORS is disabled; the
  body is capped at 4 MiB. **Plaintext HTTP only — terminate TLS at
  a reverse proxy** if exposing beyond loopback. See the
  [Production deployment section](README.md) for the full hardening
  recipe, including the gaps the bearer-token model alone does NOT
  close (no expiry, no per-tool scope, no rate limiting). The
  reverse-proxy + OAuth/OIDC pattern is the documented path for
  production exposure.
- **`compare_schema_file` scratch privileges.** The tool requires a
  writable scratch connection to load the `.sql` file into a temp
  database. Grant the scratch user the **narrowest possible**
  privileges — temp DBs created by this tool always live under the
  `_qbmcp_check_*` prefix, so:

  ```sql
  GRANT CREATE, DROP ON `_qbmcp_check_%`.* TO 'qbmcp_scratch'@'%';
  GRANT ALL PRIVILEGES ON `_qbmcp_check_%`.* TO 'qbmcp_scratch'@'%';
  ```

  Avoid granting `*.*` to the scratch user — a bug or hostile agent
  with access to that user could otherwise touch databases beyond
  the temp scratch space.

## Dependency hygiene

- We run `pnpm audit` against every release branch before publishing.
- Lockfile bumps for transitive-dep CVEs ship as `patch` releases —
  see `CHANGELOG.md` entries tagged "clear `pnpm audit` advisories".
- The published npm tarball contains only `dist/` (no `node_modules`).
  The Docker image (GHCR) bundles production `node_modules`; transitive
  vulns there are visible to scanners, which is the case we typically
  fix first.

/**
 * Typed error classes for predictable failure modes.
 *
 * Why typed errors instead of `new Error("...")`:
 *
 *  - `toolHandler` can branch on `instanceof` and pick the right
 *    `toolError` message + hint instead of dumping a raw MySQL string.
 *  - Operators reading logs see a stable `error.name` they can grep
 *    for — "ConnectionNotFound" is a load-bearing search term, not
 *    "Connection ... not found".
 *  - Tests can assert on the class, not on substring matches that
 *    drift when messages get reworded.
 *
 * Each subclass carries a `hint` (operator-facing remediation text)
 * and a `code` (stable identifier for logs and dashboards).
 *
 * **Do not throw `QueryBridgeError` directly** — always throw one of
 * the concrete subclasses. The base class exists only so `toolHandler`
 * can recognise the family in one `instanceof` check.
 */

export abstract class QueryBridgeError extends Error {
  abstract readonly code: string;
  abstract readonly hint?: string | undefined;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The query references a connection that hasn't been initialized
 * (typo in the args, or `initConnection` failed during startup).
 */
export class ConnectionNotFound extends QueryBridgeError {
  readonly code = "CONNECTION_NOT_FOUND";
  readonly hint = "Run list_connections to see configured connections.";

  constructor(name: string) {
    super(`Connection "${name}" not found or not initialized`);
  }
}

/**
 * The tool needs a database name and got neither an explicit `database`
 * arg nor a default on the connection. Handled inside `resolveDb`
 * before this even reaches `toolHandler`; included here for the rare
 * non-tool code path that needs the same check.
 */
export class DatabaseNotResolved extends QueryBridgeError {
  readonly code = "DATABASE_NOT_RESOLVED";
  readonly hint =
    "Specify a database parameter or call use_database first to pin a default.";

  constructor() {
    super("No database selected.");
  }
}

/**
 * The connection is configured `readonly: true` and the query is a
 * write. The connection config decides; the SQL whitelist
 * (`isReadOnlyQuery`) enforces.
 */
export class ReadOnlyViolation extends QueryBridgeError {
  readonly code = "READ_ONLY_VIOLATION";
  readonly hint =
    'Set "readonly": false in the connection config to enable writes.';

  constructor(connection: string, detail = "") {
    super(
      detail ||
        `Connection "${connection}" is read-only. Only SELECT, SHOW, DESCRIBE, EXPLAIN, and USE are allowed.`,
    );
  }
}

/**
 * The MCP client aborted the request mid-flight. Distinct from a
 * MySQL timeout — the latter throws an opaque "Query inactivity
 * timeout" from mysql2, while this is a cooperative cancel via
 * `extra.signal`.
 */
export class CancelledByClient extends QueryBridgeError {
  readonly code = "CANCELLED_BY_CLIENT";
  readonly hint = undefined;

  constructor(toolName: string) {
    super(`${toolName} was cancelled by the client (KILL QUERY issued).`);
  }
}

/**
 * MySQL returned an EXPLAIN FORMAT=JSON body that didn't parse.
 * Almost certainly a server-version quirk; surfaces as a tool error
 * instead of crashing the handler.
 */
export class MalformedExplainOutput extends QueryBridgeError {
  readonly code = "MALFORMED_EXPLAIN_OUTPUT";
  readonly hint =
    "Retry with format=TRADITIONAL or format=TREE for a non-JSON plan.";

  constructor(reason: string) {
    super(`EXPLAIN returned malformed JSON: ${reason}`);
  }
}

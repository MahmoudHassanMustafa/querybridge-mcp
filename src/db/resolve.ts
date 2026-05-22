import { getConnectionConfig } from "../connection.js";
import { toolError } from "../tool-runtime.js";
import { DatabaseNotResolved } from "../errors.js";

/**
 * Resolve the database a tool should target.
 *
 * Argument > connection default. Returns a tagged union so callers
 * handle the "no database selected" case at the call site:
 *
 *   const r = resolveDb(connection, database);
 *   if ("error" in r) return r.error;
 *   // r.db is now string
 *
 * The return-style (vs. throw) is deliberate: the next line in every
 * caller wants `r.db` immediately, so threading a try/catch would add
 * noise without buying anything. We *do* still pin the message + hint
 * to `DatabaseNotResolved` so the user-visible error text comes from
 * one source — drift between the class and the inline string is then
 * impossible.
 *
 * Lives in `src/db/` because it bridges the connection layer and the
 * tool layer.
 */
export function resolveDb(
  connection: string,
  database?: string,
): { db: string } | { error: ReturnType<typeof toolError> } {
  const db = database || getConnectionConfig(connection).database;
  if (!db) {
    const err = new DatabaseNotResolved();
    return { error: toolError(err.message, err.hint) };
  }
  return { db };
}

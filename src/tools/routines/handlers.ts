import { resolveDb } from "../../db/resolve.js";
import {
  findRoutineType,
  getEventDdl,
  getRoutineDdl,
  getTriggerDdl,
  listEventsBrief,
  listRoutinesBrief,
  listTriggersBrief,
} from "../../db/introspection.js";
import { formatAsTable } from "../../format.js";
import { toolOk, toolHandler } from "../../tool-runtime.js";

/**
 * Routines/triggers/events tool handlers.
 *
 * Each handler is exported as a `toolHandler`-wrapped function so the
 * registration file (`./index.ts`) wires them in declaratively and so
 * unit tests can import + invoke them with `registerMockConnection`
 * providing canned rows.
 */

export const handleListRoutines = toolHandler(
  "list_routines",
  async ({
    connection,
    database,
    type,
  }: {
    connection: string;
    database?: string | undefined;
    type?: "PROCEDURE" | "FUNCTION" | "ALL" | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;
    const routineType = type ?? "ALL";

    const routines = await listRoutinesBrief(connection, r.db, routineType);

    if (routines.length === 0) {
      return toolOk(
        `No ${routineType === "ALL" ? "routines" : routineType.toLowerCase() + "s"} found in ${r.db}`,
        { database: r.db, type: routineType, routines: [] },
      );
    }

    return toolOk(
      formatAsTable(routines) + `\n\n${routines.length} routine(s) in ${r.db}`,
      { database: r.db, type: routineType, routines },
    );
  },
);

export const handleGetRoutineDdl = toolHandler(
  "get_routine_ddl",
  async ({
    connection,
    name,
    database,
    type,
  }: {
    connection: string;
    name: string;
    database?: string | undefined;
    type?: "PROCEDURE" | "FUNCTION" | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    let routineType = type;
    if (!routineType) {
      const detected = await findRoutineType(connection, r.db, name);
      if (!detected) {
        return toolOk(`Routine "${name}" not found in ${r.db}`, {
          database: r.db,
          name,
          found: false,
        });
      }
      routineType = detected;
    }

    const ddl = await getRoutineDdl(connection, r.db, routineType, name);

    return toolOk(`-- ${routineType}: ${name}\n${ddl}`, {
      database: r.db,
      name,
      type: routineType,
      ddl,
    });
  },
);

export const handleListTriggers = toolHandler(
  "list_triggers",
  async ({
    connection,
    table,
    database,
  }: {
    connection: string;
    table?: string | undefined;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const triggers = await listTriggersBrief(connection, r.db, table);

    if (triggers.length === 0) {
      return toolOk(
        table ? `No triggers on table ${table}` : `No triggers in ${r.db}`,
        { database: r.db, table: table ?? null, triggers: [] },
      );
    }

    return toolOk(
      formatAsTable(triggers) + `\n\n${triggers.length} trigger(s)`,
      { database: r.db, table: table ?? null, triggers },
    );
  },
);

export const handleGetTriggerDdl = toolHandler(
  "get_trigger_ddl",
  async ({
    connection,
    name,
    database,
  }: {
    connection: string;
    name: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const ddl = await getTriggerDdl(connection, r.db, name);

    return toolOk(`-- TRIGGER: ${name}\n${ddl}`, {
      database: r.db,
      name,
      ddl,
    });
  },
);

export const handleListEvents = toolHandler(
  "list_events",
  async ({
    connection,
    database,
  }: {
    connection: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const events = await listEventsBrief(connection, r.db);

    if (events.length === 0) {
      return toolOk(`No events in ${r.db}`, { database: r.db, events: [] });
    }

    return toolOk(
      formatAsTable(events) + `\n\n${events.length} event(s)`,
      { database: r.db, events },
    );
  },
);

export const handleGetEventDdl = toolHandler(
  "get_event_ddl",
  async ({
    connection,
    name,
    database,
  }: {
    connection: string;
    name: string;
    database?: string | undefined;
  }) => {
    const r = resolveDb(connection, database);
    if ("error" in r) return r.error;

    const ddl = await getEventDdl(connection, r.db, name);

    return toolOk(`-- EVENT: ${name}\n${ddl}`, {
      database: r.db,
      name,
      ddl,
    });
  },
);

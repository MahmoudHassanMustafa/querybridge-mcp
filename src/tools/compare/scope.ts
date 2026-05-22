/**
 * Scope axis for compare_schemas: which aspects of the schema get
 * compared. Used by both the orchestrator (to decide what to fetch +
 * diff) and the renderer (to label the output).
 */
export const SCOPES = [
  "tables",
  "tableAttributes",
  "columns",
  "indexes",
  "foreignKeys",
  "views",
  "routines",
  "triggers",
  "events",
] as const;

export type Scope = (typeof SCOPES)[number];

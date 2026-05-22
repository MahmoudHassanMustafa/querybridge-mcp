/**
 * Shared normalized domain types for MySQL schema objects.
 *
 * Anything in here is consumed by two or more modules. Types used by a
 * single tool — including one-off row types for a specific SELECT —
 * stay co-located with that tool.
 */

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  key: string;
  comment: string;
  /** EXTRA column: AUTO_INCREMENT, ON UPDATE CURRENT_TIMESTAMP, STORED/VIRTUAL GENERATED, etc. */
  extra: string;
  /** Generated-column expression (NULL for regular columns) */
  generationExpression: string | null;
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
  /** MySQL 8 invisible indexes — same definition, hidden from the optimizer */
  visible: boolean;
  /** Per-column prefix lengths (e.g. INDEX(email(100))). null = full column. */
  subParts: Array<number | null>;
  /** Functional index expressions (MySQL 8). null when not a functional index. */
  expressions: Array<string | null>;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TableAttributes {
  name: string;
  engine: string;
  charset: string;
  collation: string;
  comment: string;
  rowFormat: string;
  partitioned: boolean;
  partitionMethod: string | null;
  partitionExpression: string | null;
  partitionCount: number;
}

export interface View {
  name: string;
  definition: string;
  updatable: boolean;
  securityType: string;
  checkOption: string;
}

export interface Routine {
  name: string;
  type: "PROCEDURE" | "FUNCTION";
  returnType: string | null;
  parameters: string;
  definition: string;
  securityType: string;
  deterministic: boolean;
  dataAccess: string;
}

export interface Trigger {
  name: string;
  table: string;
  event: string;
  timing: string;
  orientation: string;
  statement: string;
}

export interface Event {
  name: string;
  type: string;
  intervalValue: string | null;
  intervalField: string | null;
  status: string;
  starts: string | null;
  ends: string | null;
  definition: string;
}

/**
 * Diff shape shared by every comparable entity. Each kind of comparison
 * (column, index, FK, table-attr, view, routine, trigger, event) is
 * `BaseDiff<T>` for that entity's type.
 */
export interface BaseDiff<T> {
  onlyInSource: T[];
  onlyInTarget: T[];
  modified: Array<{ name: string; source: T; target: T; diffs: string[] }>;
}

export type ColumnDiff = BaseDiff<Column>;
export type IndexDiff = BaseDiff<IndexDef>;
export type FKDiff = BaseDiff<ForeignKey>;
export type TableAttrDiff = BaseDiff<TableAttributes>;
export type ViewDiff = BaseDiff<View>;
export type RoutineDiff = BaseDiff<Routine>;
export type TriggerDiff = BaseDiff<Trigger>;
export type EventDiff = BaseDiff<Event>;

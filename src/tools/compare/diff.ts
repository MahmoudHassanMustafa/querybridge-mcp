import type {
  BaseDiff,
  Column,
  ColumnDiff,
  IndexDef,
  IndexDiff,
  ForeignKey,
  FKDiff,
  TableAttributes,
  TableAttrDiff,
  View,
  ViewDiff,
  Routine,
  RoutineDiff,
  Trigger,
  TriggerDiff,
  Event,
  EventDiff,
} from "../../types/db.js";
import {
  emptyDiff,
  formatDefault,
  normalizeSQL,
  normalizeType,
  subPartString,
} from "./normalize.js";

/**
 * Pure differs. Each takes two normalized lists (source / target) and
 * returns a `BaseDiff<T>` describing onlyInSource, onlyInTarget, and
 * per-name modifications. No DB access, no I/O — kept pure so the
 * unit tests stay fast and seam-clean.
 */

export function diffColumns(srcCols: Column[], tgtCols: Column[]): ColumnDiff {
  return diffByName(srcCols, tgtCols, (src, tgt) => {
    const diffs: string[] = [];
    const srcType = normalizeType(src.type);
    const tgtType = normalizeType(tgt.type);
    if (srcType !== tgtType) diffs.push(`type: ${srcType} → ${tgtType}`);
    if (src.nullable !== tgt.nullable)
      diffs.push(`nullable: ${src.nullable} → ${tgt.nullable}`);
    if (src.default !== tgt.default)
      diffs.push(
        `default: ${formatDefault(src.default)} → ${formatDefault(tgt.default)}`,
      );
    if (src.key !== tgt.key)
      diffs.push(`key: ${src.key || "(none)"} → ${tgt.key || "(none)"}`);
    if (src.comment !== tgt.comment)
      diffs.push(`comment: '${src.comment}' → '${tgt.comment}'`);
    if (src.extra !== tgt.extra)
      diffs.push(`extra: '${src.extra}' → '${tgt.extra}'`);
    if (src.generationExpression !== tgt.generationExpression)
      diffs.push(
        `generated: ${src.generationExpression ?? "(none)"} → ${tgt.generationExpression ?? "(none)"}`,
      );
    return diffs;
  });
}

export function diffIndexes(srcIdx: IndexDef[], tgtIdx: IndexDef[]): IndexDiff {
  return diffByName(srcIdx, tgtIdx, (src, tgt) => {
    const diffs: string[] = [];
    if (src.columns.join(",") !== tgt.columns.join(","))
      diffs.push(
        `columns: (${src.columns.join(",")}) → (${tgt.columns.join(",")})`,
      );
    if (src.unique !== tgt.unique)
      diffs.push(`unique: ${src.unique} → ${tgt.unique}`);
    if (src.type !== tgt.type) diffs.push(`type: ${src.type} → ${tgt.type}`);
    if (src.visible !== tgt.visible)
      diffs.push(`visible: ${src.visible} → ${tgt.visible}`);
    if (subPartString(src.subParts) !== subPartString(tgt.subParts))
      diffs.push(
        `prefix lengths: ${subPartString(src.subParts)} → ${subPartString(tgt.subParts)}`,
      );
    return diffs;
  });
}

export function diffForeignKeys(
  srcFK: ForeignKey[],
  tgtFK: ForeignKey[],
): FKDiff {
  return diffByName(srcFK, tgtFK, (src, tgt) => {
    const diffs: string[] = [];
    if (src.columns.join(",") !== tgt.columns.join(","))
      diffs.push(
        `columns: (${src.columns.join(",")}) → (${tgt.columns.join(",")})`,
      );
    if (src.referencedTable !== tgt.referencedTable)
      diffs.push(`references: ${src.referencedTable} → ${tgt.referencedTable}`);
    if (src.referencedColumns.join(",") !== tgt.referencedColumns.join(","))
      diffs.push(
        `referenced columns: (${src.referencedColumns.join(",")}) → (${tgt.referencedColumns.join(",")})`,
      );
    if (src.onUpdate !== tgt.onUpdate)
      diffs.push(`ON UPDATE: ${src.onUpdate} → ${tgt.onUpdate}`);
    if (src.onDelete !== tgt.onDelete)
      diffs.push(`ON DELETE: ${src.onDelete} → ${tgt.onDelete}`);
    return diffs;
  });
}

export function diffTableAttributes(
  src: Map<string, TableAttributes>,
  tgt: Map<string, TableAttributes>,
): TableAttrDiff {
  const srcArr = [...src.values()];
  const tgtArr = [...tgt.values()];
  return diffByName(srcArr, tgtArr, (a, b) => {
    const diffs: string[] = [];
    if (a.engine !== b.engine) diffs.push(`engine: ${a.engine} → ${b.engine}`);
    if (a.charset !== b.charset)
      diffs.push(`charset: ${a.charset} → ${b.charset}`);
    if (a.collation !== b.collation)
      diffs.push(`collation: ${a.collation} → ${b.collation}`);
    if (a.comment !== b.comment)
      diffs.push(`comment: '${a.comment}' → '${b.comment}'`);
    if (a.rowFormat !== b.rowFormat)
      diffs.push(`row format: ${a.rowFormat} → ${b.rowFormat}`);
    if (a.partitioned !== b.partitioned)
      diffs.push(
        `partitioning: ${a.partitioned ? "yes" : "no"} → ${b.partitioned ? "yes" : "no"}`,
      );
    else if (a.partitioned && b.partitioned) {
      if (a.partitionMethod !== b.partitionMethod)
        diffs.push(
          `partition method: ${a.partitionMethod} → ${b.partitionMethod}`,
        );
      if (a.partitionExpression !== b.partitionExpression)
        diffs.push(
          `partition expr: ${a.partitionExpression} → ${b.partitionExpression}`,
        );
      if (a.partitionCount !== b.partitionCount)
        diffs.push(
          `partition count: ${a.partitionCount} → ${b.partitionCount}`,
        );
    }
    return diffs;
  });
}

export function diffViews(srcViews: View[], tgtViews: View[]): ViewDiff {
  return diffByName(srcViews, tgtViews, (a, b) => {
    const diffs: string[] = [];
    if (normalizeSQL(a.definition) !== normalizeSQL(b.definition))
      diffs.push("definition changed");
    if (a.updatable !== b.updatable)
      diffs.push(`updatable: ${a.updatable} → ${b.updatable}`);
    if (a.securityType !== b.securityType)
      diffs.push(`security: ${a.securityType} → ${b.securityType}`);
    if (a.checkOption !== b.checkOption)
      diffs.push(`check option: ${a.checkOption} → ${b.checkOption}`);
    return diffs;
  });
}

export function diffRoutines(srcR: Routine[], tgtR: Routine[]): RoutineDiff {
  return diffByName(srcR, tgtR, (a, b) => {
    const diffs: string[] = [];
    if (a.type !== b.type) diffs.push(`type: ${a.type} → ${b.type}`);
    if (a.returnType !== b.returnType)
      diffs.push(
        `returns: ${a.returnType ?? "(none)"} → ${b.returnType ?? "(none)"}`,
      );
    if (a.parameters !== b.parameters)
      diffs.push(`parameters: (${a.parameters}) → (${b.parameters})`);
    if (normalizeSQL(a.definition) !== normalizeSQL(b.definition))
      diffs.push("body changed");
    if (a.securityType !== b.securityType)
      diffs.push(`security: ${a.securityType} → ${b.securityType}`);
    if (a.deterministic !== b.deterministic)
      diffs.push(`deterministic: ${a.deterministic} → ${b.deterministic}`);
    if (a.dataAccess !== b.dataAccess)
      diffs.push(`data access: ${a.dataAccess} → ${b.dataAccess}`);
    return diffs;
  });
}

export function diffTriggers(srcT: Trigger[], tgtT: Trigger[]): TriggerDiff {
  return diffByName(srcT, tgtT, (a, b) => {
    const diffs: string[] = [];
    if (a.table !== b.table) diffs.push(`table: ${a.table} → ${b.table}`);
    if (a.event !== b.event) diffs.push(`event: ${a.event} → ${b.event}`);
    if (a.timing !== b.timing) diffs.push(`timing: ${a.timing} → ${b.timing}`);
    if (a.orientation !== b.orientation)
      diffs.push(`orientation: ${a.orientation} → ${b.orientation}`);
    if (normalizeSQL(a.statement) !== normalizeSQL(b.statement))
      diffs.push("statement changed");
    return diffs;
  });
}

export function diffEvents(srcE: Event[], tgtE: Event[]): EventDiff {
  return diffByName(srcE, tgtE, (a, b) => {
    const diffs: string[] = [];
    if (a.type !== b.type) diffs.push(`type: ${a.type} → ${b.type}`);
    if (
      a.intervalValue !== b.intervalValue ||
      a.intervalField !== b.intervalField
    )
      diffs.push(
        `interval: ${a.intervalValue ?? ""} ${a.intervalField ?? ""} → ${b.intervalValue ?? ""} ${b.intervalField ?? ""}`,
      );
    if (a.status !== b.status) diffs.push(`status: ${a.status} → ${b.status}`);
    if (normalizeSQL(a.definition) !== normalizeSQL(b.definition))
      diffs.push("body changed");
    return diffs;
  });
}

/**
 * Generic name-keyed differ. Avoids duplicating the same compare-by-name
 * + sort-results boilerplate across every object type.
 */
function diffByName<T extends { name: string }>(
  src: T[],
  tgt: T[],
  compare: (a: T, b: T) => string[],
): BaseDiff<T> {
  const srcMap = new Map(src.map((x) => [x.name, x]));
  const tgtMap = new Map(tgt.map((x) => [x.name, x]));
  const result: BaseDiff<T> = emptyDiff();

  for (const [name, a] of srcMap) {
    const b = tgtMap.get(name);
    if (!b) {
      result.onlyInSource.push(a);
      continue;
    }
    const diffs = compare(a, b);
    if (diffs.length > 0)
      result.modified.push({ name, source: a, target: b, diffs });
  }
  for (const [name, b] of tgtMap) {
    if (!srcMap.has(name)) result.onlyInTarget.push(b);
  }
  result.onlyInSource.sort((x, y) => x.name.localeCompare(y.name));
  result.onlyInTarget.sort((x, y) => x.name.localeCompare(y.name));
  result.modified.sort((x, y) => x.name.localeCompare(y.name));
  return result;
}

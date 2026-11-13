import { MAX_STEP_DEPTH, dropBlankSteps, isStepGroup, newId, type StepNode } from '@nabbit/recipe-core';

/** Editor view of a step tree: every row has a stable id for tracking and for addressing edits. */
export type StepRow =
  | { id: string; kind: 'step'; text: string }
  | { id: string; kind: 'group'; heading: string; children: StepRow[] };

/** Rows for a stored tree. A flat list gives only step rows (no wrapper group). */
export function toRows(nodes: StepNode[]): StepRow[] {
  return nodes.map(
    (n): StepRow =>
      isStepGroup(n)
        ? { id: newId(), kind: 'group', heading: n.heading ?? '', children: toRows(n.steps) }
        : { id: newId(), kind: 'step', text: n },
  );
}

function toNodes(rows: StepRow[]): StepNode[] {
  return rows.map((r): StepNode => {
    if (r.kind === 'step') return r.text;
    const steps = toNodes(r.children);
    return r.heading.trim() === '' ? { steps } : { heading: r.heading, steps };
  });
}

/** Tree to save: blank steps and groups left empty dropped; an empty heading becomes a headingless group. */
export function fromRows(rows: StepRow[]): StepNode[] {
  return dropBlankSteps(toNodes(rows));
}

/** Id-free view with nothing dropped, for the dirty check. */
export function shape(rows: StepRow[]): unknown[] {
  return rows.map((r) => (r.kind === 'step' ? r.text : { heading: r.heading, steps: shape(r.children) }));
}

/** Depth in the units of recipe-core's `stepDepth`: 1 for a flat list, +1 per group level. */
export function rowDepth(rows: StepRow[]): number {
  return rows.reduce((max, r) => Math.max(max, r.kind === 'group' ? 1 + rowDepth(r.children) : 1), 0);
}

export function hasChildren(row: StepRow): boolean {
  return row.kind === 'group' && row.children.length > 0;
}

/** Number shown for the step at `index`: steps only, so groups do not use up numbers. */
export function stepNumber(level: StepRow[], index: number): number {
  return level.slice(0, index + 1).filter((r) => r.kind === 'step').length;
}

/** Applies fn to the sibling list under `parentId` (null = top level). */
function mapLevel(rows: StepRow[], parentId: string | null, fn: (level: StepRow[]) => StepRow[]): StepRow[] {
  if (parentId === null) return fn(rows);
  return rows.map((r) => {
    if (r.kind !== 'group') return r;
    if (r.id === parentId) return { ...r, children: fn(r.children) };
    const children = mapLevel(r.children, parentId, fn);
    return children === r.children ? r : { ...r, children };
  });
}

const blankStep = (): StepRow => ({ id: newId(), kind: 'step', text: '' });
const blankGroup = (): StepRow => ({ id: newId(), kind: 'group', heading: '', children: [] });

export function addStep(rows: StepRow[], parentId: string | null): StepRow[] {
  return mapLevel(rows, parentId, (level) => [...level, blankStep()]);
}

export function addGroup(rows: StepRow[], parentId: string | null): StepRow[] {
  return mapLevel(rows, parentId, (level) => [...level, blankGroup()]);
}

function mapRow(rows: StepRow[], id: string, fn: (r: StepRow) => StepRow): StepRow[] {
  return rows.map((r) => {
    if (r.id === id) return fn(r);
    if (r.kind !== 'group') return r;
    const children = mapRow(r.children, id, fn);
    return children === r.children ? r : { ...r, children };
  });
}

export function setText(rows: StepRow[], id: string, text: string): StepRow[] {
  return mapRow(rows, id, (r) => (r.kind === 'step' ? { ...r, text } : r));
}

export function setHeading(rows: StepRow[], id: string, heading: string): StepRow[] {
  return mapRow(rows, id, (r) => (r.kind === 'group' ? { ...r, heading } : r));
}

export function removeRow(rows: StepRow[], id: string): StepRow[] {
  const kept = rows.filter((r) => r.id !== id);
  if (kept.length !== rows.length) return kept;
  return rows.map((r) => {
    if (r.kind !== 'group') return r;
    const children = removeRow(r.children, id);
    return children === r.children ? r : { ...r, children };
  });
}

interface Location {
  level: StepRow[];
  index: number;
  parent: StepRow | null;
}

/** Finds the sibling list holding `id`, and its parent group (null at top level). */
function locate(rows: StepRow[], id: string, parent: StepRow | null = null): Location | null {
  const index = rows.findIndex((r) => r.id === id);
  if (index >= 0) return { level: rows, index, parent };
  for (const r of rows) {
    if (r.kind === 'group') {
      const hit = locate(r.children, id, r);
      if (hit) return hit;
    }
  }
  return null;
}

/** Moves a row to the end of the group directly above it. Returns `rows` itself when that is not possible. */
export function indent(rows: StepRow[], id: string): StepRow[] {
  const at = locate(rows, id);
  if (!at || at.index === 0) return rows;
  const above = at.level[at.index - 1];
  if (above.kind !== 'group') return rows;
  const moving = at.level[at.index];
  const next = mapLevel(rows, at.parent?.id ?? null, (level) =>
    level.flatMap((r, i) => {
      if (i === at.index) return [];
      if (i === at.index - 1 && r.kind === 'group') return [{ ...r, children: [...r.children, moving] }];
      return [r];
    }),
  );
  return rowDepth(next) > MAX_STEP_DEPTH ? rows : next;
}

/** Moves a row to just after its parent group. Returns `rows` itself at the top level. */
export function outdent(rows: StepRow[], id: string): StepRow[] {
  const at = locate(rows, id);
  if (!at?.parent) return rows;
  const moving = at.level[at.index];
  const parentId = at.parent.id;
  const without = mapLevel(rows, parentId, (level) => level.filter((r) => r.id !== id));
  const grand = locate(without, parentId);
  if (!grand) return rows;
  return mapLevel(without, grand.parent?.id ?? null, (level) => {
    const i = level.findIndex((r) => r.id === parentId);
    return [...level.slice(0, i + 1), moving, ...level.slice(i + 1)];
  });
}

export const canIndent = (rows: StepRow[], id: string): boolean => indent(rows, id) !== rows;
export const canOutdent = (rows: StepRow[], id: string): boolean => outdent(rows, id) !== rows;

/** Reorders within one level. */
export function moveWithin(rows: StepRow[], parentId: string | null, from: number, to: number): StepRow[] {
  return mapLevel(rows, parentId, (level) => {
    const next = [...level];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  });
}

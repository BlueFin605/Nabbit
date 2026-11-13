import { MAX_STEP_DEPTH, type StepNode } from '@nabbit/recipe-core';
import {
  addGroup,
  addStep,
  canAddGroup,
  canAddStep,
  canIndent,
  canOutdent,
  fromRows,
  hasChildren,
  lastChildId,
  neighbourAfterRemove,
  indent,
  moveWithin,
  outdent,
  removeRow,
  rowDepth,
  setHeading,
  setText,
  shape,
  stepNumber,
  toRows,
  type StepRow,
} from './step-rows';

const nested: StepNode[] = [
  'Prep',
  { heading: 'Dough', steps: ['Mix', { heading: 'Knead', steps: ['Push', 'Fold'] }] },
  { steps: ['No heading'] },
  'Serve',
];

type GroupRow = Extract<StepRow, { kind: 'group' }>;
const group = (rows: StepRow[], i: number) => rows[i] as GroupRow;

/** A tree whose depth is exactly `levels` (1 = a lone step). */
function deepNode(levels: number): StepNode {
  let node: StepNode = 'leaf';
  for (let i = 1; i < levels; i++) node = { steps: [node] };
  return node;
}

describe('step-rows', () => {
  it('flat steps round-trip with no wrapper groups', () => {
    const rows = toRows(['Mix', 'Fry']);
    expect(rows.every((r) => r.kind === 'step')).toBe(true);
    expect(fromRows(rows)).toEqual(['Mix', 'Fry']);
  });

  it('nested steps round-trip identically, including a headingless group', () => {
    expect(fromRows(toRows(nested))).toEqual(nested);
  });

  it('fromRows drops blank steps and emptied groups; an empty heading means headingless', () => {
    let rows = toRows(['A']);
    rows = addGroup(rows, null);
    const g = rows[1].id;
    rows = addStep(rows, g);
    rows = addGroup(rows, null);
    rows = addStep(rows, null);
    expect(fromRows(rows)).toEqual(['A']);
    rows = setText(rows, group(rows, 1).children[0].id, 'Inner');
    expect(fromRows(rows)).toEqual(['A', { steps: ['Inner'] }]);
    rows = setHeading(rows, g, 'Sauce');
    expect(fromRows(rows)).toEqual(['A', { heading: 'Sauce', steps: ['Inner'] }]);
  });

  it('adds a step or group at the top level and inside a group', () => {
    let rows = toRows([{ heading: 'G', steps: ['x'] }]);
    rows = addStep(rows, null);
    rows = addGroup(rows, rows[0].id);
    expect(rows.map((r) => r.kind)).toEqual(['group', 'step']);
    expect(group(rows, 0).children.map((r) => r.kind)).toEqual(['step', 'group']);
  });

  it('removes a row anywhere and reports children', () => {
    const rows = toRows(nested);
    expect(hasChildren(rows[1])).toBe(true);
    expect(hasChildren(rows[0])).toBe(false);
    const out = removeRow(rows, group(rows, 1).children[1].id);
    expect(fromRows(out)[1]).toEqual({ heading: 'Dough', steps: ['Mix'] });
  });

  it('numbers steps only, restarting per level', () => {
    const rows = toRows(['a', { steps: ['x'] }, 'b']);
    expect([0, 2].map((i) => stepNumber(rows, i))).toEqual([1, 2]);
  });

  it('indents into the group directly above, at its end', () => {
    const rows = toRows([{ heading: 'G', steps: ['a'] }, 'b']);
    expect(canIndent(rows, rows[1].id)).toBe(true);
    expect(fromRows(indent(rows, rows[1].id))).toEqual([{ heading: 'G', steps: ['a', 'b'] }]);
  });

  it('cannot indent with no group directly above', () => {
    const rows = toRows(['a', 'b', { heading: 'G', steps: ['c'] }]);
    expect(canIndent(rows, rows[0].id)).toBe(false);
    expect(canIndent(rows, rows[1].id)).toBe(false);
    expect(indent(rows, rows[1].id)).toBe(rows);
  });

  it('outdents to just after its parent group; disabled at top level', () => {
    const rows = toRows([{ heading: 'G', steps: ['a', 'b'] }, 'z']);
    const a = group(rows, 0).children[0].id;
    expect(canOutdent(rows, a)).toBe(true);
    expect(canOutdent(rows, rows[1].id)).toBe(false);
    expect(fromRows(outdent(rows, a))).toEqual([{ heading: 'G', steps: ['b'] }, 'a', 'z']);
    expect(outdent(rows, rows[1].id)).toBe(rows);
  });

  it('outdent from a deeper level lands inside the grandparent', () => {
    const rows = toRows([{ heading: 'A', steps: [{ heading: 'B', steps: ['x', 'y'] }] }]);
    const b = group(rows, 0).children[0] as GroupRow;
    expect(fromRows(outdent(rows, b.children[0].id))).toEqual([{ heading: 'A', steps: [{ heading: 'B', steps: ['y'] }, 'x'] }]);
  });

  it('refuses an indent that would exceed MAX_STEP_DEPTH, allows one that reaches it', () => {
    // [empty group, tree of depth MAX]: indenting it into the group would make MAX + 1.
    const tooDeep = toRows([{ steps: [] }, deepNode(MAX_STEP_DEPTH)]);
    expect(rowDepth(tooDeep)).toBe(MAX_STEP_DEPTH);
    expect(canIndent(tooDeep, tooDeep[1].id)).toBe(false);
    const ok = toRows([{ steps: [] }, deepNode(MAX_STEP_DEPTH - 1)]);
    expect(canIndent(ok, ok[1].id)).toBe(true);
    expect(rowDepth(indent(ok, ok[1].id))).toBe(MAX_STEP_DEPTH);
  });

  it('reorders within one level only', () => {
    const rows = toRows([{ heading: 'G', steps: ['a', 'b', 'c'] }, 'x', 'y']);
    expect(fromRows(moveWithin(rows, null, 2, 1))).toEqual([{ heading: 'G', steps: ['a', 'b', 'c'] }, 'y', 'x']);
    expect(fromRows(moveWithin(rows, rows[0].id, 0, 2))[0]).toEqual({ heading: 'G', steps: ['b', 'c', 'a'] });
  });

  it('shape ignores ids but keeps blank rows', () => {
    expect(shape(toRows(['a', '']))).toEqual(['a', '']);
    expect(shape(toRows(nested))).toEqual(shape(toRows(nested)));
    expect(shape(toRows([{ steps: ['x'] }]))).toEqual([{ heading: '', steps: ['x'] }]);
  });

  describe('depth guard for new groups', () => {
    const deepestGroup = (rows: StepRow[]): GroupRow => {
      let g = group(rows, 0);
      for (;;) {
        const next = g.children.find((c) => c.kind === 'group');
        if (!next) return g;
        g = next;
      }
    };

    it('allows a group (holding a step) within MAX_STEP_DEPTH, refuses beyond', () => {
      const ok = toRows([deepNode(MAX_STEP_DEPTH - 1)]);
      expect(canAddGroup(ok, null)).toBe(true);
      expect(canAddGroup(ok, deepestGroup(ok).id)).toBe(true);
      const full = toRows([deepNode(MAX_STEP_DEPTH)]);
      expect(canAddGroup(full, deepestGroup(full).id)).toBe(false);
      expect(canAddGroup(full, null)).toBe(true);
    });

    it('addGroup returns the same rows when the group would be too deep', () => {
      const full = toRows([deepNode(MAX_STEP_DEPTH)]);
      expect(addGroup(full, deepestGroup(full).id)).toBe(full);
    });

    it('repeatedly adding groups through the guard never exceeds the limit', () => {
      let rows: StepRow[] = [];
      let parent: string | null = null;
      for (let i = 0; i < 10 && canAddGroup(rows, parent); i++) {
        rows = addGroup(rows, parent);
        parent = lastChildId(rows, parent);
        rows = addStep(rows, parent);
      }
      expect(rowDepth(rows)).toBe(MAX_STEP_DEPTH);
    });
  });

  describe('empty groups count as able to hold a step', () => {
    /** MAX_STEP_DEPTH - 2 wrapping groups around [empty group, empty group]. */
    const wrapped = (): StepRow[] => {
      let node: StepNode = { steps: [{ steps: [] }, { steps: [] }] };
      for (let i = 0; i < MAX_STEP_DEPTH - 3; i++) node = { steps: [node] };
      return toRows([node]);
    };
    const innermost = (rows: StepRow[]): GroupRow => {
      let g = group(rows, 0);
      while (g.children[0]?.kind === 'group' && g.children.length === 1) g = g.children[0];
      return g;
    };

    it('rowDepth of an empty group is 2', () => {
      expect(rowDepth(toRows([{ steps: [] }]))).toBe(2);
    });

    it('refuses to indent an empty group into the deepest allowed empty group', () => {
      const rows = wrapped();
      const holder = innermost(rows);
      expect(rowDepth(rows)).toBe(MAX_STEP_DEPTH);
      expect(canIndent(rows, holder.children[1].id)).toBe(false);
      expect(indent(rows, holder.children[1].id)).toBe(rows);
    });

    it('addStep refuses where the new step would exceed MAX_STEP_DEPTH', () => {
      let node: StepNode = { steps: [] };
      for (let i = 1; i < MAX_STEP_DEPTH; i++) node = { steps: [node] };
      const rows = toRows([node]);
      let g = group(rows, 0);
      while (g.children[0]?.kind === 'group') g = g.children[0];
      expect(canAddStep(rows, g.id)).toBe(false);
      expect(addStep(rows, g.id)).toBe(rows);
      const fits = toRows([deepNode(MAX_STEP_DEPTH)]);
      let h = group(fits, 0);
      while (h.children[0]?.kind === 'group') h = h.children[0];
      expect(canAddStep(fits, h.id)).toBe(true);
    });
  });

  it('lastChildId finds the newest row at a level', () => {
    let rows = toRows(['a']);
    rows = addStep(rows, null);
    expect(lastChildId(rows, null)).toBe(rows[1].id);
    expect(lastChildId([], null)).toBeNull();
  });

  it('neighbourAfterRemove picks the next sibling, else the previous, else the level', () => {
    const rows = toRows([{ heading: 'G', steps: ['a', 'b'] }, 'z']);
    const g = group(rows, 0);
    expect(neighbourAfterRemove(rows, g.children[0].id)).toEqual({ neighbourId: g.children[1].id, parentId: g.id });
    expect(neighbourAfterRemove(rows, g.children[1].id)).toEqual({ neighbourId: g.children[0].id, parentId: g.id });
    expect(neighbourAfterRemove(rows, rows[1].id)).toEqual({ neighbourId: g.id, parentId: null });
    const solo = toRows([{ heading: 'G', steps: ['a'] }]);
    expect(neighbourAfterRemove(solo, group(solo, 0).children[0].id)).toEqual({ neighbourId: null, parentId: solo[0].id });
  });
});

import { describe, expect, it } from 'vitest';
import {
  MAX_STEP_COUNT,
  MAX_STEP_DEPTH,
  countSteps,
  dropBlankSteps,
  flattenSteps,
  isStepGroup,
  mapSteps,
  stepDepth,
} from '../src/steps';
import type { StepNode } from '../src/types';

const flat: StepNode[] = ['a', 'b', 'c'];
const nested: StepNode[] = [{ heading: 'Dough', steps: ['mix', { heading: 'Rest', steps: ['wait'] }] }, 'bake'];
const mixed: StepNode[] = ['prep', { heading: 'Sauce', steps: ['chop', 'simmer'] }, 'serve'];

const nest = (levels: number): StepNode[] => {
  let node: StepNode[] = ['leaf'];
  for (let i = 1; i < levels; i++) node = [{ steps: node }];
  return node;
};

describe('constants', () => {
  it('exposes limits', () => {
    expect(MAX_STEP_DEPTH).toBe(5);
    expect(MAX_STEP_COUNT).toBe(100);
  });
});

describe('isStepGroup', () => {
  it('distinguishes groups from strings', () => {
    expect(isStepGroup('x')).toBe(false);
    expect(isStepGroup({ steps: [] })).toBe(true);
  });
});

describe('flattenSteps', () => {
  it('round-trips a flat list', () => expect(flattenSteps(flat)).toEqual(flat));
  it('flattens nested depth-first without headings', () => expect(flattenSteps(nested)).toEqual(['mix', 'wait', 'bake']));
  it('handles mixed', () => expect(flattenSteps(mixed)).toEqual(['prep', 'chop', 'simmer', 'serve']));
  it('handles empty and empty group', () => {
    expect(flattenSteps([])).toEqual([]);
    expect(flattenSteps([{ heading: 'x', steps: [] }])).toEqual([]);
  });
  it('handles heading-less group', () => expect(flattenSteps([{ steps: ['a'] }, 'b'])).toEqual(['a', 'b']));
});

describe('countSteps', () => {
  it('counts leaves', () => {
    expect(countSteps(flat)).toBe(3);
    expect(countSteps(nested)).toBe(3);
    expect(countSteps(mixed)).toBe(4);
    expect(countSteps([])).toBe(0);
    expect(countSteps([{ steps: [] }])).toBe(0);
  });
});

describe('stepDepth', () => {
  it('is 1 for a flat list', () => expect(stepDepth(flat)).toBe(1));
  it('measures nesting', () => {
    expect(stepDepth(mixed)).toBe(2);
    expect(stepDepth(nested)).toBe(3);
  });
  it('distinguishes depth 5 from 6', () => {
    expect(stepDepth(nest(5))).toBe(5);
    expect(stepDepth(nest(6))).toBe(6);
    expect(stepDepth(nest(6))).toBeGreaterThan(MAX_STEP_DEPTH);
  });
  it('is 0 for an empty list', () => expect(stepDepth([])).toBe(0));
});

describe('mapSteps', () => {
  const up = (s: string): string => s.toUpperCase();
  it('maps a flat list', () => expect(mapSteps(flat, up)).toEqual(['A', 'B', 'C']));
  it('preserves structure and headings', () => {
    expect(mapSteps(nested, up)).toEqual([
      { heading: 'Dough', steps: ['MIX', { heading: 'Rest', steps: ['WAIT'] }] },
      'BAKE',
    ]);
  });
  it('keeps heading-less groups heading-less', () => {
    const out = mapSteps([{ steps: ['a'] }], up);
    expect(out).toEqual([{ steps: ['A'] }]);
    expect('heading' in (out[0] as object)).toBe(false);
  });
  it('does not mutate input', () => {
    mapSteps(nested, up);
    expect(flattenSteps(nested)).toEqual(['mix', 'wait', 'bake']);
  });
});

describe('dropBlankSteps', () => {
  it('leaves a flat list unchanged', () => expect(dropBlankSteps(flat)).toEqual(flat));
  it('removes blank and whitespace strings', () => expect(dropBlankSteps(['a', '', '  ', 'b'])).toEqual(['a', 'b']));
  it('removes groups left empty, recursively', () => {
    const input: StepNode[] = [
      'a',
      { heading: 'Outer', steps: [{ heading: 'Inner', steps: ['', ' '] }] },
      { heading: 'Empty', steps: [] },
      { heading: 'Keep', steps: ['x', { steps: ['  '] }] },
    ];
    expect(dropBlankSteps(input)).toEqual(['a', { heading: 'Keep', steps: ['x'] }]);
  });
  it('keeps heading-less groups with content', () => expect(dropBlankSteps([{ steps: ['a', ''] }])).toEqual([{ steps: ['a'] }]));
});

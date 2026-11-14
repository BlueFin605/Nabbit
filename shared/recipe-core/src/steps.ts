import type { StepGroup, StepNode } from './types';

export const MAX_STEP_DEPTH = 5;
export const MAX_STEP_COUNT = 100;

export function isStepGroup(n: StepNode): n is StepGroup {
  return typeof n !== 'string';
}

/** Depth-first leaf strings; headings excluded. */
export function flattenSteps(nodes: StepNode[]): string[] {
  return nodes.flatMap((n) => (isStepGroup(n) ? flattenSteps(n.steps) : [n]));
}

/** Number of leaf strings. */
export function countSteps(nodes: StepNode[]): number {
  return nodes.reduce((total, n) => total + (isStepGroup(n) ? countSteps(n.steps) : 1), 0);
}

/** 1 for a flat list, plus one per level of group nesting; 0 for an empty list. */
export function stepDepth(nodes: StepNode[]): number {
  return nodes.reduce((max, n) => Math.max(max, isStepGroup(n) ? 1 + stepDepth(n.steps) : 1), 0);
}

/** Applies fn to every leaf string, preserving structure and headings. */
export function mapSteps(nodes: StepNode[], fn: (text: string) => string): StepNode[] {
  return nodes.map((n) => (isStepGroup(n) ? { ...n, steps: mapSteps(n.steps, fn) } : fn(n)));
}

/** Removes blank strings and groups left empty, recursively. */
export function dropBlankSteps(nodes: StepNode[]): StepNode[] {
  const out: StepNode[] = [];
  for (const n of nodes) {
    if (isStepGroup(n)) {
      const steps = dropBlankSteps(n.steps);
      if (steps.length > 0) out.push({ ...n, steps });
    } else if (n.trim() !== '') {
      out.push(n);
    }
  }
  return out;
}

import { describe, expect, it } from 'vitest';
import type { DraftConfidence, RecipeDraft } from '../src/index';

describe('DraftConfidence', () => {
  it("accepts 'ai' alongside structured and heuristic", () => {
    const all = ['structured', 'heuristic', 'ai'] as const satisfies readonly DraftConfidence[];
    const draft = {
      recipe: { title: 't', servings: 1, ingredients: [], steps: [], tags: [] },
      confidence: 'ai',
    } satisfies RecipeDraft;
    expect(all).toContain(draft.confidence);
  });
});

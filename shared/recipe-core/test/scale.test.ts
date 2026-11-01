import { describe, expect, it } from 'vitest';
import { formatQuantity, scaleIngredient, scaleRecipeIngredients, roundMetric, toMetric } from '../src/index';
import type { Ingredient, Unit } from '../src/index';

const ing = (quantity: number | null, unit: Unit, name: string, extra: Partial<Ingredient> = {}): Ingredient =>
  toMetric({ id: 'x', quantity, unit, name, scalable: true, ...extra });

describe('scale + format (original mode)', () => {
  it.each([
    [ing(2, 'cup', 'flour'), 1.5, '3 cups flour'],
    [ing(1, 'tbsp', 'oil'), 0.5, '½ tbsp oil'],
    [ing(1 / 3, 'cup', 'sugar'), 3, '1 cup sugar'],
    [ing(1, 'cup', 'milk'), 1 / 3, '⅓ cup milk'],
    [ing(3, '', 'eggs'), 2, '6 eggs'],
    [ing(1, 'cup', 'rice'), 1.5, '1½ cups rice'],
    [ing(1, 'cup', 'rice'), 2, '2 cups rice'],
    [ing(1, 'tsp', 'salt'), 0.05, 'a pinch of salt'],
    [ing(1, 'cup', 'salt'), 0.05, '0.05 cup salt'],
    [ing(1, 'cup', 'x'), 0.8, '¾ cup x'],
  ])('%j x%d -> %s', (i, f, expected) => {
    expect(formatQuantity(scaleIngredient(i, f), 'original')).toBe(expected);
  });

  it('formats ranges', () => {
    expect(formatQuantity(ing(2, 'cup', 'stock', { quantityMax: 3 }), 'original')).toBe('2–3 cups stock');
    const s = scaleIngredient(ing(1, 'cup', 'stock', { quantityMax: 2 }), 2);
    expect(s.quantity).toBe(2);
    expect(s.quantityMax).toBe(4);
  });

  it('formats a null quantity as the name', () => {
    expect(formatQuantity(ing(null, '', 'salt'), 'original')).toBe('salt');
  });
});

describe('metric mode', () => {
  it('formats 1/3 cup as 80 ml', () => {
    expect(formatQuantity(ing(1 / 3, 'cup', 'sugar'), 'metric')).toBe('80 ml sugar');
  });
  it('250 g x2.5 matches roundMetric', () => {
    const s = scaleIngredient(ing(250, 'g', 'butter'), 2.5);
    const m = roundMetric({ quantity: 625, unit: 'g' });
    expect(s.metric).toEqual(m);
    expect(formatQuantity(s, 'metric')).toBe(`${m.quantity} g butter`);
  });
  it('steps ml up to l', () => {
    expect(formatQuantity(ing(1500, 'ml', 'water'), 'metric')).toBe('1.5 l water');
  });
  it('recomputes metric from scaled quantity, not rounded metric', () => {
    const s = scaleIngredient(ing(1, 'tsp', 'x'), 3);
    expect(s.metric).toEqual(toMetric({ ...s }).metric);
    expect(s.metric).toEqual(roundMetric({ quantity: 3 * 4.92892, unit: 'ml' }));
  });
  it('falls back to original text when no metric', () => {
    expect(formatQuantity(ing(3, '', 'eggs'), 'metric')).toBe('3 eggs');
  });
  it('formats metric ranges', () => {
    expect(formatQuantity(ing(1, 'cup', 'stock', { quantityMax: 2 }), 'metric')).toBe('240–480 ml stock');
  });
});

describe('non-scalable', () => {
  const taste = ing(null, '', 'salt', { scalable: false, original: 'salt, to taste' });
  it('is returned unchanged', () => {
    expect(scaleIngredient(taste, 3)).toEqual(taste);
  });
  it('renders its original text', () => {
    expect(formatQuantity(taste, 'original')).toBe('salt, to taste');
    expect(formatQuantity(taste, 'metric')).toBe('salt, to taste');
  });
  it('a non-scalable quantity is not scaled', () => {
    const i = ing(1, 'cup', 'x', { scalable: false });
    expect(scaleIngredient(i, 2)).toEqual(i);
  });
});

describe('scaleRecipeIngredients', () => {
  it('scales by to/from without mutating', () => {
    const list = [ing(2, 'cup', 'flour')];
    const out = scaleRecipeIngredients(list, 4, 6);
    expect(out[0].quantity).toBe(3);
    expect(list[0].quantity).toBe(2);
  });
  it.each([[0, 2], [2, 0], [-1, 2], [2, -1]])('throws RangeError for %d -> %d', (from, to) => {
    expect(() => scaleRecipeIngredients([], from, to)).toThrow(RangeError);
  });
});

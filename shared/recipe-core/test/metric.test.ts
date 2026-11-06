import { describe, expect, it } from 'vitest';
import { convertTemperatures, fToC, roundMetric, toMetric } from '../src/index';
import type { Ingredient, Unit } from '../src/index';

const ing = (quantity: number | null, unit: Unit, extra: Partial<Ingredient> = {}): Ingredient => ({
  id: 'x',
  quantity,
  unit,
  name: 'thing',
  scalable: true,
  ...extra,
});

describe('toMetric', () => {
  it.each([
    [1, 'cup', 240, 'ml'],
    [0.25, 'cup', 60, 'ml'],
    [2, 'tbsp', 30, 'ml'],
    [1, 'tsp', 5, 'ml'],
    [1, 'lb', 450, 'g'],
    [8, 'oz', 230, 'g'],
    [4, 'cup', 960, 'ml'],
    [6, 'cup', 1.45, 'l'],
    [1, 'gallon', 3.79, 'l'],
    [2.2, 'lb', 1, 'kg'],
    [500, 'g', 500, 'g'],
    [1500, 'ml', 1.5, 'l'],
    [2, 'l', 2, 'l'],
  ] as const)('%s %s -> %s %s', (q, unit, mq, mu) => {
    expect(toMetric(ing(q, unit)).metric).toEqual({ quantity: mq, unit: mu });
  });

  it.each([
    [3, 'piece'],
    [3, ''],
    [null, 'cup'],
  ] as const)('%s %s has no metric', (q, unit) => {
    expect(toMetric(ing(q, unit)).metric).toBeUndefined();
  });

  it('passes through unknown units', () => {
    expect(toMetric(ing(2, 'bunch' as Unit)).metric).toBeUndefined();
  });

  it('does not mutate and returns a copy', () => {
    const src = ing(1, 'cup');
    const out = toMetric(src);
    expect(src.metric).toBeUndefined();
    expect(out).not.toBe(src);
  });

  it('clears stale metric when not convertible', () => {
    expect(toMetric(ing(3, 'piece', { metric: { quantity: 1, unit: 'g' } })).metric).toBeUndefined();
  });

  it('keeps quantityMax in the original unit', () => {
    const out = toMetric(ing(2, 'cup', { quantityMax: 3 }));
    expect(out.metric).toEqual({ quantity: 480, unit: 'ml' });
    expect(out.quantityMax).toBe(3);
  });
});

describe('roundMetric', () => {
  it.each([
    [4.93, 'ml', 5, 'ml'],
    [3.1, 'ml', 3, 'ml'],
    [14.79, 'ml', 15, 'ml'],
    [123, 'ml', 120, 'ml'],
    [1440, 'ml', 1.45, 'l'],
    [1.2345, 'l', 1.23, 'l'],
    [12.4, 'g', 12, 'g'],
    [47, 'g', 45, 'g'],
    [453.6, 'g', 450, 'g'],
    [998, 'g', 1, 'kg'],
    [2268, 'g', 2.27, 'kg'],
    [1.5, 'kg', 1.5, 'kg'],
  ] as const)('%s %s -> %s %s', (q, u, rq, ru) => {
    expect(roundMetric({ quantity: q, unit: u })).toEqual({ quantity: rq, unit: ru });
  });
});

describe('fToC', () => {
  it.each([
    [350, 180],
    [425, 220],
    [40, 4],
    [212, 100],
  ])('%s F -> %s C', (f, c) => {
    expect(fToC(f)).toBe(c);
  });
});

describe('convertTemperatures', () => {
  it.each([
    ['bake at 350°F', 'bake at 180°C'],
    ['425 °F', '220°C'],
    ['chill to 40°F', 'chill to 4°C'],
    ['bake at 350°F then 425°F.', 'bake at 180°C then 220°C.'],
    ['no temperature here', 'no temperature here'],
    ['already 180°C', 'already 180°C'],
  ])('%s', (input, out) => {
    expect(convertTemperatures(input)).toBe(out);
  });
});

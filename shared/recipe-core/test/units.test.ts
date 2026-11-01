import { describe, expect, it } from 'vitest';
import { G_PER, ML_PER, newId, normaliseUnit } from '../src/index';

describe('normaliseUnit', () => {
  it.each([
    ['Tablespoons', 'tbsp'],
    ['tbsp', 'tbsp'],
    ['tsp.', 'tsp'],
    ['T', 'tbsp'],
    ['cups', 'cup'],
    ['c', 'cup'],
    ['lbs', 'lb'],
    ['pound', 'lb'],
    ['ounces', 'oz'],
    ['grams', 'g'],
    ['kg', 'kg'],
    ['millilitres', 'ml'],
    ['fl oz', 'floz'],
  ])('%s -> %s', (raw, unit) => {
    expect(normaliseUnit(raw)).toBe(unit);
  });

  it('returns undefined for unknown units', () => {
    expect(normaliseUnit('bunch')).toBeUndefined();
    expect(normaliseUnit('')).toBeUndefined();
  });
});

describe('conversion tables', () => {
  it('uses a 240 ml cup', () => {
    expect(ML_PER.cup).toBe(240);
    expect(ML_PER.l).toBe(1000);
    expect(G_PER.lb).toBe(453.592);
  });
});

describe('newId', () => {
  it('returns unique non-empty ids', () => {
    const a = newId();
    expect(a.length).toBeGreaterThan(0);
    expect(newId()).not.toBe(a);
  });
});

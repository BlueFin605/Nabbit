import { describe, expect, it } from 'vitest';
import { anchorAmount, factorFromTarget, isScaleAnchor, scaleIngredient, toMetric } from '../src/index';
import type { Ingredient, Unit } from '../src/index';

const ing = (quantity: number | null, unit: Unit, name: string, extra: Partial<Ingredient> = {}): Ingredient =>
  toMetric({ id: 'x', quantity, unit, name, scalable: true, ...extra });

describe('isScaleAnchor', () => {
  it('accepts scalable ingredients with a quantity', () => expect(isScaleAnchor(ing(1, 'l', 'milk'))).toBe(true));
  it('rejects null quantity', () => expect(isScaleAnchor(ing(null, '', 'salt'))).toBe(false));
  it('rejects a zero quantity', () => expect(isScaleAnchor(ing(0, 'g', 'flour'))).toBe(false));
  it('rejects non-scalable', () => expect(isScaleAnchor(ing(1, 'l', 'milk', { scalable: false }))).toBe(false));
});

describe('factorFromTarget', () => {
  it('same unit', () => expect(factorFromTarget(ing(4, 'l', 'milk'), { quantity: 6, unit: 'l' })).toBeCloseTo(1.5));
  it('ml stored vs l target', () => expect(factorFromTarget(ing(4000, 'ml', 'milk'), { quantity: 6, unit: 'l' })).toBeCloseTo(1.5));
  it('l stored vs ml target', () => expect(factorFromTarget(ing(4, 'l', 'milk'), { quantity: 2000, unit: 'ml' })).toBeCloseTo(0.5));
  it('cup to ml', () => expect(factorFromTarget(ing(1, 'cup', 'milk'), { quantity: 480, unit: 'ml' })).toBeCloseTo(2));
  it('g to kg', () => expect(factorFromTarget(ing(500, 'g', 'flour'), { quantity: 1, unit: 'kg' })).toBeCloseTo(2));
  it('oz to g', () => expect(factorFromTarget(ing(4, 'oz', 'cheese'), { quantity: 28.3495 * 8, unit: 'g' })).toBeCloseTo(2));
  it('volume vs weight is null', () => {
    expect(factorFromTarget(ing(1, 'l', 'milk'), { quantity: 1, unit: 'kg' })).toBeNull();
    expect(factorFromTarget(ing(1, 'kg', 'flour'), { quantity: 1, unit: 'l' })).toBeNull();
  });
  it('count units match only themselves', () => {
    expect(factorFromTarget(ing(2, 'piece', 'egg'), { quantity: 6, unit: 'piece' })).toBeCloseTo(3);
    expect(factorFromTarget(ing(2, '', 'egg'), { quantity: 6, unit: '' })).toBeCloseTo(3);
    expect(factorFromTarget(ing(2, 'piece', 'egg'), { quantity: 6, unit: '' })).toBeNull();
    expect(factorFromTarget(ing(2, '', 'egg'), { quantity: 6, unit: 'piece' })).toBeNull();
    expect(factorFromTarget(ing(2, 'piece', 'egg'), { quantity: 6, unit: 'g' })).toBeNull();
  });
  it('non-anchors give null', () => {
    expect(factorFromTarget(ing(null, '', 'salt'), { quantity: 1, unit: '' })).toBeNull();
    expect(factorFromTarget(ing(1, 'l', 'milk', { scalable: false }), { quantity: 2, unit: 'l' })).toBeNull();
  });
  it('range anchors on quantity', () =>
    expect(factorFromTarget(ing(2, 'cup', 'flour', { quantityMax: 3 }), { quantity: 4, unit: 'cup' })).toBeCloseTo(2));
  it('target <= 0 throws', () => {
    expect(() => factorFromTarget(ing(1, 'l', 'milk'), { quantity: 0, unit: 'l' })).toThrow(RangeError);
    expect(() => factorFromTarget(ing(1, 'l', 'milk'), { quantity: -1, unit: 'l' })).toThrow(RangeError);
  });
  it('derived factor scales the anchor to the target', () => {
    const milk = ing(4, 'l', 'milk');
    const f = factorFromTarget(milk, { quantity: 6, unit: 'l' })!;
    expect(scaleIngredient(milk, f).quantity).toBeCloseTo(6);
  });
});

describe('anchorAmount', () => {
  it('returns quantity in the ingredient unit', () => expect(anchorAmount(ing(4, 'l', 'milk'))).toEqual({ quantity: 4, unit: 'l' }));
  it('ranges use quantity', () =>
    expect(anchorAmount(ing(2, 'cup', 'flour', { quantityMax: 3 }))).toEqual({ quantity: 2, unit: 'cup' }));
});

import { describe, expect, it } from 'vitest';
import { parseIngredient } from '../src/index';

type Expected = {
  quantity: number | null;
  quantityMax?: number;
  unit: string;
  name: string;
  note?: string;
  scalable: boolean;
};

const cases: [string, Expected][] = [
  ['2 cups flour', { quantity: 2, unit: 'cup', name: 'flour', scalable: true }],
  ['1 1/2 tbsp olive oil', { quantity: 1.5, unit: 'tbsp', name: 'olive oil', scalable: true }],
  ['1½ tbsp olive oil', { quantity: 1.5, unit: 'tbsp', name: 'olive oil', scalable: true }],
  ['½ tsp salt', { quantity: 0.5, unit: 'tsp', name: 'salt', scalable: true }],
  ['1/4 cup sugar', { quantity: 0.25, unit: 'cup', name: 'sugar', scalable: true }],
  ['¼ cup sugar', { quantity: 0.25, unit: 'cup', name: 'sugar', scalable: true }],
  ['¾ cup milk', { quantity: 0.75, unit: 'cup', name: 'milk', scalable: true }],
  ['⅛ tsp pepper', { quantity: 0.125, unit: 'tsp', name: 'pepper', scalable: true }],
  ['2⅓ cups flour', { quantity: 2 + 1 / 3, unit: 'cup', name: 'flour', scalable: true }],
  ['⅔ cup oil', { quantity: 2 / 3, unit: 'cup', name: 'oil', scalable: true }],
  ['⅓ cup oil', { quantity: 1 / 3, unit: 'cup', name: 'oil', scalable: true }],
  ['2-3 cloves garlic', { quantity: 2, quantityMax: 3, unit: '', name: 'cloves garlic', scalable: true }],
  ['2 to 3 cloves garlic', { quantity: 2, quantityMax: 3, unit: '', name: 'cloves garlic', scalable: true }],
  ['2-3 cups flour', { quantity: 2, quantityMax: 3, unit: 'cup', name: 'flour', scalable: true }],
  ['1 can (400g) chickpeas', { quantity: 1, unit: '', name: 'can chickpeas', note: '400g', scalable: true }],
  ['1 (14 oz) can tomatoes', { quantity: 1, unit: '', name: 'can tomatoes', note: '14 oz', scalable: true }],
  ['2 carrots, diced', { quantity: 2, unit: '', name: 'carrots', note: 'diced', scalable: true }],
  ['3 eggs', { quantity: 3, unit: '', name: 'eggs', scalable: true }],
  ['1 bay leaf', { quantity: 1, unit: '', name: 'bay leaf', scalable: true }],
  ['salt to taste', { quantity: null, unit: '', name: 'salt', note: 'to taste', scalable: false }],
  ['a pinch of salt', { quantity: null, unit: '', name: 'salt', note: 'pinch', scalable: false }],
  ['a dash of hot sauce', { quantity: null, unit: '', name: 'hot sauce', note: 'dash', scalable: false }],
  ['olive oil, as needed', { quantity: null, unit: '', name: 'olive oil', note: 'as needed', scalable: false }],
  ['  - 2 cups flour  ', { quantity: 2, unit: 'cup', name: 'flour', scalable: true }],
  ['• 2 cups flour', { quantity: 2, unit: 'cup', name: 'flour', scalable: true }],
  ['1&frac12; cups flour', { quantity: 1.5, unit: 'cup', name: 'flour', scalable: true }],
  ['&#189; cup milk', { quantity: 0.5, unit: 'cup', name: 'milk', scalable: true }],
  ['salt &amp; pepper', { quantity: null, unit: '', name: 'salt & pepper', scalable: false }],
];

describe('parseIngredient', () => {
  it.each(cases)('parses %j', (line, exp) => {
    const r = parseIngredient(line);
    expect(r.quantity).toBeCloseTo(exp.quantity ?? 0, 10);
    if (exp.quantity === null) expect(r.quantity).toBeNull();
    expect(r.quantityMax).toBe(exp.quantityMax);
    expect(r.unit).toBe(exp.unit);
    expect(r.name).toBe(exp.name);
    expect(r.note).toBe(exp.note);
    expect(r.scalable).toBe(exp.scalable);
    expect(r.original).toBe(line);
    expect(r.id).toBeTruthy();
  });

  it('returns the fallback shape for unparseable lines and never throws', () => {
    for (const line of ['', '   ', '???', 'Some random text']) {
      const r = parseIngredient(line);
      expect(r.quantity).toBeNull();
      expect(r.unit).toBe('');
      expect(r.scalable).toBe(false);
      expect(r.original).toBe(line);
    }
    expect(parseIngredient('  ??? ').name).toBe('???');
  });

  it('sets scalable true whenever quantity is a number', () => {
    expect(parseIngredient('3 eggs').scalable).toBe(true);
    expect(parseIngredient('eggs').scalable).toBe(false);
  });
});

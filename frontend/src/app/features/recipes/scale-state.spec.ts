import type { Ingredient } from '@nabbit/recipe-core';
import { anchorFactor, formatFactor, parseAmount, roundHalf, unitsInFamily } from './scale-state';

const milk: Ingredient = { id: 'm', original: '4 l milk', quantity: 4, unit: 'l', name: 'milk', scalable: true };

describe('scale-state', () => {
  it('parseAmount accepts decimals, comma decimals and spaces; rejects junk and <= 0', () => {
    expect(parseAmount('6')).toBe(6);
    expect(parseAmount(' 1.5 ')).toBe(1.5);
    expect(parseAmount('1,5')).toBe(1.5);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-2')).toBeNull();
    expect(parseAmount('Infinity')).toBeNull();
  });

  it('roundHalf rounds to the nearest 0.5', () => {
    expect(roundHalf(6)).toBe(6);
    expect(roundHalf(6.3)).toBe(6.5);
    expect(roundHalf(6.2)).toBe(6);
    expect(roundHalf(0.1)).toBe(0);
  });

  it('unitsInFamily lists the same family, or just the unit for counts', () => {
    expect(unitsInFamily('l')).toEqual(expect.arrayContaining(['ml', 'l', 'cup']));
    expect(unitsInFamily('l')).not.toContain('g');
    expect(unitsInFamily('g')).toEqual(expect.arrayContaining(['g', 'kg', 'oz', 'lb']));
    expect(unitsInFamily('piece')).toEqual(['piece']);
    expect(unitsInFamily('')).toEqual(['']);
  });

  it('anchorFactor returns a factor, or an error message', () => {
    expect(anchorFactor(milk, '6', 'l')).toEqual({ factor: 1.5 });
    expect(anchorFactor(milk, '6000', 'ml')).toEqual({ factor: 1.5 });
    expect(anchorFactor(milk, 'x', 'l')).toEqual({ error: 'Enter an amount greater than zero.' });
    expect(anchorFactor(milk, '2', 'g')).toEqual({ error: "Can't convert g to l." });
  });

  it('formatFactor trims trailing zeros', () => {
    expect(formatFactor(1.5)).toBe('1.5');
    expect(formatFactor(2)).toBe('2');
    expect(formatFactor(1 / 3)).toBe('0.33');
  });
});

import { toMetric } from './metric';
import { G_PER, ML_PER } from './units';
import type { Ingredient, MetricAmount, Unit } from './types';

/** Returns a scaled copy. Non-scalable ingredients are returned unchanged. Metric is recomputed from the scaled quantity. */
export function scaleIngredient(i: Ingredient, factor: number): Ingredient {
  if (!i.scalable || i.quantity === null) return i;
  const scaled: Ingredient = { ...i, quantity: i.quantity * factor };
  if (i.quantityMax !== undefined) scaled.quantityMax = i.quantityMax * factor;
  return toMetric(scaled);
}

export function scaleRecipeIngredients(ings: Ingredient[], from: number, to: number): Ingredient[] {
  if (!(from > 0) || !(to > 0)) throw new RangeError('servings must be greater than zero');
  const factor = to / from;
  return ings.map((i) => scaleIngredient(i, factor));
}

export type AnchorTarget = { quantity: number; unit: Unit };

/** True when the ingredient can anchor scaling: quantity !== null and scalable. */
export function isScaleAnchor(i: Ingredient): boolean {
  return i.scalable && i.quantity !== null;
}

/** Family and base amount per unit. Count units ('piece', '') are each their own family. */
function baseOf(unit: Unit): [string, number] {
  if (Object.hasOwn(ML_PER, unit)) return ['volume', ML_PER[unit as keyof typeof ML_PER]];
  if (Object.hasOwn(G_PER, unit)) return ['weight', G_PER[unit as keyof typeof G_PER]];
  return [`count:${unit}`, 1];
}

/**
 * Factor that makes ingredient `i` equal `target`. Throws RangeError if target.quantity <= 0.
 * Returns null when the units are in different families (volume, weight, or the same count unit)
 * or `i` is not an anchor. Ranges anchor on `quantity`. No density: volume vs weight is null.
 */
export function factorFromTarget(i: Ingredient, target: AnchorTarget): number | null {
  if (!(target.quantity > 0)) throw new RangeError('target quantity must be greater than zero');
  if (!isScaleAnchor(i) || !((i.quantity as number) > 0)) return null;
  const [fi, bi] = baseOf(i.unit);
  const [ft, bt] = baseOf(target.unit);
  if (fi !== ft) return null;
  return (target.quantity * bt) / ((i.quantity as number) * bi);
}

/** Current anchor amount of `i` in `i.unit`, for presetting the amount box. Callers must check `isScaleAnchor(i)` first (quantity is null otherwise). */
export function anchorAmount(i: Ingredient): AnchorTarget {
  return { quantity: i.quantity as number, unit: i.unit };
}

const FRACTIONS: [number, string][] = [
  [0, ''],
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [1 / 2, '½'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
  [1, ''],
];

const PLURAL_UNITS: Partial<Record<Unit, [string, string]>> = {
  cup: ['cup', 'cups'],
  pint: ['pint', 'pints'],
  quart: ['quart', 'quarts'],
  gallon: ['gallon', 'gallons'],
  piece: ['piece', 'pieces'],
  floz: ['fl oz', 'fl oz'],
};

function unitLabel(unit: Unit, quantity: number): string {
  if (unit === '') return '';
  const forms = PLURAL_UNITS[unit];
  return forms ? (quantity > 1 ? forms[1] : forms[0]) : unit;
}

/** Cooking-fraction text for a quantity ("1½", "⅓", "2"); decimal below ⅛. */
function formatNumber(q: number): string {
  if (q < 1 / 8) return String(Number(q.toFixed(2)));
  let whole = Math.floor(q);
  const frac = q - whole;
  const [value, glyph] = FRACTIONS.reduce((best, f) => (Math.abs(f[0] - frac) < Math.abs(best[0] - frac) ? f : best));
  if (value === 1) whole += 1;
  if (!glyph) return String(whole);
  return whole > 0 ? `${whole}${glyph}` : glyph;
}

const join = (...parts: string[]): string => parts.filter((p) => p !== '').join(' ');

function formatOriginal(i: Ingredient): string {
  if (i.quantity === null) return i.name;
  const top = i.quantityMax ?? i.quantity;
  if (i.unit === 'tsp' && top < 1 / 8) return `a pinch of ${i.name}`;
  const amount =
    i.quantityMax !== undefined ? `${formatNumber(i.quantity)}–${formatNumber(i.quantityMax)}` : formatNumber(i.quantity);
  return join(amount, unitLabel(i.unit, top), i.name);
}

function formatMetric(i: Ingredient): string | undefined {
  const m = i.metric;
  if (!m) return undefined;
  const fmt = (a: MetricAmount): string => `${a.quantity}`;
  let amount = `${fmt(m)} ${m.unit}`;
  if (i.quantityMax !== undefined) {
    const max = toMetric({ ...i, quantity: i.quantityMax }).metric;
    if (max) {
      amount = max.unit === m.unit ? `${fmt(m)}–${fmt(max)} ${m.unit}` : `${fmt(m)} ${m.unit}–${fmt(max)} ${max.unit}`;
    }
  }
  return join(amount, i.name);
}

/** Display text for an ingredient line in the chosen measurement mode. */
export function formatQuantity(i: Ingredient, mode: 'original' | 'metric'): string {
  if (!i.scalable && i.original) return i.original;
  if (mode === 'metric') {
    const text = formatMetric(i);
    if (text !== undefined) return text;
  }
  return formatOriginal(i);
}


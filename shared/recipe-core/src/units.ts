import type { Unit, VolumeUnit, WeightUnit } from './types';

/** Millilitres per volume unit (cup is 240 ml; US customary pints/quarts/gallons). */
export const ML_PER: Record<VolumeUnit, number> = {
  tsp: 4.92892,
  tbsp: 14.7868,
  floz: 29.5735,
  cup: 240,
  pint: 473.176,
  quart: 946.353,
  gallon: 3785.41,
  ml: 1,
  l: 1000,
};

/** Grams per weight unit. */
export const G_PER: Record<WeightUnit, number> = {
  oz: 28.3495,
  lb: 453.592,
  g: 1,
  kg: 1000,
};

const groups: Record<Exclude<Unit, ''>, string[]> = {
  tsp: ['tsp', 'tsps', 'teaspoon', 'teaspoons', 't'],
  tbsp: ['tbsp', 'tbsps', 'tbs', 'tbl', 'tablespoon', 'tablespoons', 'T'],
  floz: ['floz', 'fl oz', 'fl. oz', 'fluid ounce', 'fluid ounces'],
  cup: ['cup', 'cups', 'c'],
  pint: ['pint', 'pints', 'pt', 'pts'],
  quart: ['quart', 'quarts', 'qt', 'qts'],
  gallon: ['gallon', 'gallons', 'gal'],
  ml: ['ml', 'mls', 'milliliter', 'milliliters', 'millilitre', 'millilitres'],
  l: ['l', 'liter', 'liters', 'litre', 'litres'],
  oz: ['oz', 'ounce', 'ounces'],
  lb: ['lb', 'lbs', 'pound', 'pounds'],
  g: ['g', 'gram', 'grams', 'gr'],
  kg: ['kg', 'kgs', 'kilogram', 'kilograms', 'kilo', 'kilos'],
  piece: ['piece', 'pieces', 'pc', 'pcs'],
};

/** Lower-cased alias to canonical unit. Bare 't'/'T' are handled in normaliseUnit (case matters). */
export const UNIT_ALIASES: Record<string, Unit> = Object.fromEntries(
  Object.entries(groups).flatMap(([unit, aliases]) =>
    aliases.filter((a) => a !== 't' && a !== 'T').map((a) => [a.toLowerCase(), unit as Unit]),
  ),
);
UNIT_ALIASES['t'] = 'tsp';

/**
 * Map a raw unit string ("Tablespoons", "tsp.", "T", "lbs") to a canonical Unit,
 * or undefined if unrecognised. A bare capital "T" is tablespoon; lower-case "t" is teaspoon.
 */
export function normaliseUnit(raw: string): Unit | undefined {
  const trimmed = raw.trim().replace(/\.+$/, '').trim();
  if (trimmed === 'T') return 'tbsp';
  const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
  return Object.hasOwn(UNIT_ALIASES, key) ? UNIT_ALIASES[key] : undefined;
}

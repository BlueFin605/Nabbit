import { G_PER, ML_PER, factorFromTarget, type Ingredient, type Unit } from '@nabbit/recipe-core';

/** Parses a typed amount: trims, accepts a comma decimal; null unless a finite number > 0. */
export function parseAmount(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/** Nearest 0.5 (derived servings display). */
export function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

/** Units that can stand in for `unit`: the same volume or weight family; counts offer only themselves. */
export function unitsInFamily(unit: Unit): Unit[] {
  if (Object.hasOwn(ML_PER, unit)) return Object.keys(ML_PER) as Unit[];
  if (Object.hasOwn(G_PER, unit)) return Object.keys(G_PER) as Unit[];
  return [unit];
}

export type AnchorResult = { factor: number } | { error: string };

/** Factor for "make this ingredient `text` `unit`", or an inline error message. */
export function anchorFactor(anchor: Ingredient, text: string, unit: Unit): AnchorResult {
  const quantity = parseAmount(text);
  if (quantity === null) return { error: 'Enter an amount greater than zero.' };
  const factor = factorFromTarget(anchor, { quantity, unit });
  if (factor === null) return { error: `Can't convert ${unit || 'that unit'} to ${anchor.unit || 'the recipe unit'}.` };
  return { factor };
}

/** "1.5", "2", "0.33". */
export function formatFactor(factor: number): string {
  return String(Number(factor.toFixed(2)));
}

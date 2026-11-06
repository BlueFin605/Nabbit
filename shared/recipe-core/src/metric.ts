import { G_PER, ML_PER } from './units';
import type { Ingredient, MetricAmount, VolumeUnit, WeightUnit } from './types';

const roundTo = (value: number, step: number): number => Math.round(value / step) * step;
const trim = (value: number, decimals: number): number => Number(value.toFixed(decimals));

/** Round a millilitre value into cooking-friendly steps. */
function roundMl(ml: number): number {
  if (ml < 10) return roundTo(ml, 0.5);
  if (ml < 100) return roundTo(ml, 5);
  if (ml < 1000) return roundTo(ml, 10);
  if (ml < 2000) return roundTo(ml, 25);
  return ml;
}

/** Round a gram value into cooking-friendly steps. */
function roundG(g: number): number {
  if (g < 20) return Math.round(g);
  if (g < 200) return roundTo(g, 5);
  return roundTo(g, 10);
}

/** Cooking-friendly rounding plus stepping up to l / kg at 1000. */
export function roundMetric(m: MetricAmount): MetricAmount {
  if (m.unit === 'ml' || m.unit === 'l') {
    const ml = roundMl(m.unit === 'l' ? m.quantity * 1000 : m.quantity);
    return ml >= 1000 ? { quantity: trim(ml / 1000, 2), unit: 'l' } : { quantity: trim(ml, 1), unit: 'ml' };
  }
  const g = roundG(m.unit === 'kg' ? m.quantity * 1000 : m.quantity);
  return g >= 1000 ? { quantity: trim(g / 1000, 2), unit: 'kg' } : { quantity: g, unit: 'g' };
}

function convert(quantity: number, unit: string): MetricAmount | undefined {
  if (Object.hasOwn(ML_PER, unit)) {
    return roundMetric({ quantity: quantity * ML_PER[unit as VolumeUnit], unit: 'ml' });
  }
  if (Object.hasOwn(G_PER, unit)) {
    return roundMetric({ quantity: quantity * G_PER[unit as WeightUnit], unit: 'g' });
  }
  return undefined;
}

/** Returns a copy with `metric` set (undefined when not convertible). Never mutates. */
export function toMetric(i: Ingredient): Ingredient {
  const { metric: _stale, ...rest } = i;
  void _stale;
  const metric = i.quantity === null ? undefined : convert(i.quantity, i.unit);
  return metric ? { ...rest, metric } : { ...rest };
}

/** Fahrenheit to Celsius: nearest 10 for oven temps (>= 100 F), else nearest integer. */
export function fToC(f: number): number {
  const c = ((f - 32) * 5) / 9;
  return f >= 100 ? Math.round(c / 10) * 10 : Math.round(c);
}

/** Replace "350°F" style temperatures inside free text with Celsius. */
export function convertTemperatures(text: string): string {
  return text.replace(/(\d+(?:\.\d+)?)\s*°\s*F\b/g, (_m, n: string) => `${fToC(Number(n))}°C`);
}

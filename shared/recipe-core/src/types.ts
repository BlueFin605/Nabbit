/** Volume units (US customary plus metric). */
export type VolumeUnit = 'tsp' | 'tbsp' | 'floz' | 'cup' | 'pint' | 'quart' | 'gallon' | 'ml' | 'l';
/** Weight units (US customary plus metric). */
export type WeightUnit = 'oz' | 'lb' | 'g' | 'kg';
/** Any ingredient unit; '' means unitless and 'piece' is a counted item. */
export type Unit = VolumeUnit | WeightUnit | 'piece' | '';

/** A metric rendering of an ingredient amount. */
export interface MetricAmount {
  quantity: number;
  unit: 'ml' | 'l' | 'g' | 'kg';
}

export interface Ingredient {
  id: string;
  /** The raw line as originally written. */
  original?: string;
  /** null when no numeric quantity (e.g. "salt to taste"). */
  quantity: number | null;
  /** Upper bound for ranges such as "2-3 cups". */
  quantityMax?: number;
  unit: Unit;
  name: string;
  note?: string;
  metric?: MetricAmount;
  /** Whether the quantity scales with servings. */
  scalable: boolean;
}

export interface Recipe {
  id: string;
  title: string;
  sourceUrl?: string;
  imageKey?: string;
  servings: number;
  ingredients: Ingredient[];
  steps: string[];
  tags: string[];
  version: number;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Set when soft-deleted. */
  deletedAt?: string;
}

/** A parsed-but-unsaved recipe, as produced by the importer. */
export interface RecipeDraft {
  recipe: Omit<Recipe, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
  confidence: 'structured' | 'heuristic';
}

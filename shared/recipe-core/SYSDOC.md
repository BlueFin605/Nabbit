# recipe-core — Nabbit

What this is: `@nabbit/recipe-core`, the pure TypeScript library shared by backend and frontend. No I/O, no network, no runtime dependencies. The backend uses it at import time (parse + convert); the frontend uses it for scaling, display and list types. Consumed as source through the npm workspace (`import ... from '@nabbit/recipe-core'`).

## Public API (`src/index.ts`)

- Types: `Recipe`, `RecipeDraft` (recipe fields minus id/version/timestamps, plus `confidence: 'structured' | 'heuristic'`), `Ingredient` (`quantity` may be null, optional `quantityMax` for ranges, `unit`, `name`, `note`, `original`, `metric`, `scalable`), `MetricAmount`, unit types, `ShoppingList`, `ListItem`.
- `parseIngredient(line)` — free text to `Ingredient` (fractions, ranges, sizes in brackets; "to taste" items are `scalable: false`).
- `toMetric`, `roundMetric`, `convertTemperatures`, `fToC` — volume to ml/l, weight to g/kg (a cup is 240 ml), Fahrenheit in text to Celsius, with cooking-friendly rounding. Unrecognised input passes through unchanged.
- `scaleIngredient`, `scaleRecipeIngredients(ings, from, to)`, `formatQuantity(ingredient, 'original' | 'metric')` — scaling and display text. `formatQuantity` renders quantity and name only; it omits `note`.
- `UNIT_ALIASES`, `ML_PER`, `G_PER`, `normaliseUnit`, `newId`, `CATEGORIES` (aisle order: Produce, Dairy, Meat & Fish, Bakery, Pantry, Frozen, Drinks, Household, Other).

## Where things are

`src/` has one file per concern (`units`, `parse-ingredient`, `metric`, `scale`, `lists`, `types`, `id`); table-driven tests in `test/`. Run `npm test -w shared/recipe-core` and `npm run typecheck -w shared/recipe-core`.

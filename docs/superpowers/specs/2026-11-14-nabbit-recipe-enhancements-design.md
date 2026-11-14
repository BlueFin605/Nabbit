# Nabbit recipe enhancements: design

Date: 2026-11-14. Three independent pieces, built and mergeable separately, sharing one data-model change in `shared/recipe-core`.

1. Avatar menu (who is signed in, Sign out hangs off it).
2. Nested step groups (recursive, backwards compatible, structured imports keep sections).
3. Scale by ingredient (per-recipe default anchor, reset, first-size backup and restore).

## 1. Data model (`shared/recipe-core`)

All additions are optional or accept the old shape. Existing stored recipes need no migration.

- **Steps.** `type StepNode = string | StepGroup`; `StepGroup = { heading?: string; steps: StepNode[] }`; `Recipe.steps: StepNode[]` (and `RecipeDraft`). A plain string is an ordinary step, so every existing flat `string[]` is already valid. Helpers: `flattenSteps`, `countSteps`, and a numbering walk. Numbering restarts inside each group. Limits (enforced in the backend validator): depth cap about 5, total 100 steps, the existing 350 KB item limit. Code that treated `steps` as `string[]` (for example the length checks in `backend/src/routes/import.ts`) goes through the helpers.
- **`scaleBy?`**: reference to one ingredient, the recipe's default scaling anchor. Absent on old recipes, which behave as today. If ingredients have no stable id, the editor keeps the reference in sync on reorder and delete (settled in the plan after checking the type).
- **`originalSize?: { servings, ingredients }`**: written once, by the first Save as new size; never overwritten by later saves; cleared only by Restore. Editor edits leave it alone.

## 2. Avatar menu (frontend only)

- `app.html` gets a slim top bar (app name left, avatar button right), shown under the same condition as the current bottom nav (signed in, not `/signin` or `/callback`). The bottom nav keeps Recipes and Lists; Sign out leaves it.
- Avatar: circle with the initial of `auth.user().displayName`, falling back to email, then "?". Background colour from a hash of the user id (stable between sessions). No photo (Cognito has none).
- Tapping opens a popover: display name, email, Sign out. Sign out calls the existing `App.signOut()`, so the Cognito Hosted UI logout path is unchanged. Closes on outside tap, Escape or navigation. Keyboard and screen-reader support: `aria-haspopup`, focus returns to the button, labelled.
- Auth disabled (dev): shows the mock "Local Dev User"; Sign out goes to `/signin` as today.
- Tests: component spec (initial, fallback order, open/close, sign-out call); e2e specs that click the nav Sign out use the menu instead.

## 3. Nested steps

- **Detail view** (`recipe-detail.ts`): recursive render. A group with a heading shows it as a sub-heading with an indented ordered list restarting at 1; a headingless group is just an indented list. Metric-mode temperature conversion applies to step text at any depth.
- **Editor** (`recipe-editor.ts`): flat `StepRow` list becomes a tree of nodes (step row or group row with heading input). Add step and Add group at any level; Indent and Outdent buttons (touch friendly: move into the group above, or out to the parent); drag-drop reorder within a level; deleting a group with children asks for confirmation. Blank steps and empty groups are dropped on save.
- **Structured imports only:** `extract-structured.ts` `stepsFrom` keeps `HowToSection` / `itemListElement` nesting, section `name` becomes the group heading, any depth; flat recipes stay flat. Same for microdata. Gatsby `methodGroup` data stays flat: Gatsby pages carry no schema.org Recipe, so they only reach the flat text/LLM path. The LLM path (prompt and validator) and pasted-text path stay flat.
- **Import preview merge:** `mergeDrafts` dedupes on lower-cased step text at any depth; new steps from extra text append at the top level.
- **Validation:** `backend/src/routes/recipes.ts` accepts `string | { heading?, steps }` with the depth and count caps.
- **Tests:** recipe-core helpers; backend validator and extraction (nested, flat, mixed); frontend editor and detail specs; e2e building and saving a nested recipe; the `.frcol` API schema.

## 4. Scale by ingredient

- **Core:** `factorFromTarget(ingredient, target)` converts the target amount into the ingredient's unit family using the existing `toMetric` tables and returns `target / ingredient.quantity`. Volume and weight do not interconvert (no density table). Ranges anchor on `quantity`. Existing `scaleRecipeIngredients` / `scaleIngredient` apply the factor unchanged.
- **Eligible anchors:** numeric `quantity` and `scalable: true`. "To taste" and "a pinch" are excluded from the picker.
- **Recipe view:** a "Scale by" selector above the amount control: Servings, or one eligible ingredient. Servings mode keeps today's stepper. Ingredient mode replaces it with an amount box and unit preset to the stored amount, with a "×factor" and "≈ N servings" line. A different unit of the same family converts (mL against L); the wrong family is rejected with a message. The existing `scaledIngredients` computed takes the derived factor, so add-to-list works unchanged.
- **Per-recipe default:** the editor marks one ingredient as the anchor (`scaleBy`). The recipe then opens in ingredient mode on it; the selector can still switch to Servings.
- **Reset:** shown whenever the view differs from the stored size, in either mode; one tap returns to stored servings or anchor amount. Non-destructive.
- **Save as new size:** works in both modes. The confirm dialog shows before and after, with derived servings rounded to the nearest whole number or half. The first save writes `originalSize`; later saves leave it. `scaleBy` keeps pointing at the same ingredient.
- **Restore original size:** shown whenever `originalSize` exists. The dialog compares current with original per ingredient, marks lines that differ, and warns that any changes since the first resize are lost. Confirm restores servings and ingredients and clears `originalSize`; the next resize starts a fresh backup. Editor edits do not clear it.
- **Backend:** `recipes.ts` validates `scaleBy` (must reference an existing ingredient) and `originalSize` (same ingredient shape and caps as the live recipe).
- **Tests:** `factorFromTarget` (unit conversion, wrong family, ranges, null quantity); detail and editor specs; validator tests; e2e of the mozzarella case (anchor on milk, scale, save, restore); the `.frcol` schema.

## Out of scope

- Steps from the LLM and pasted-text import paths (they stay flat).
- Multi-level undo; only the first-size backup exists.
- Volume to weight conversion in ingredient scaling.
- Profile photos or account settings behind the avatar.

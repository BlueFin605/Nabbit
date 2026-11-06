# Nabbit enhancements — design

Date: 2026-11-06. Branch: `feature/nabbit-enhancements`.

Four independent enhancements to the working Nabbit MVP. Each can ship as its own piece.

## 1. Automatic recipe photo (find, choose, save)

**Today:** import returns at most one `imageUrl` (structured data only). The preview labels it "Photo not saved" and loads it on demand.

**Change:**

- **Import returns ranked `candidates`.** `POST /recipes/import` response gains `candidates: string[]` (absolute https URLs, max 6, de-duplicated, best first). `imageUrl` is kept and equals `candidates[0]` for backward compatibility. Ranking: JSON-LD/microdata `image`, then `og:image` / `twitter:image`, then `<img>` tags scored by `width`/`height` attributes (larger is better; tiny, icon, sprite, tracking-pixel and `data:` images excluded) and document position nearest the recipe content. Pure HTML parsing, no JavaScript executed, same node/depth/size budgets as the existing extractors. Relative URLs are resolved against the final fetched URL; non-https candidates are dropped. Text imports return no candidates.
- **New route `POST /recipes/images/import`** `{ url }` -> 200 `{ imageKey }`. Registered on the **import Lambda only** (shares its rate limit and reserved concurrency). Downloads through the existing SSRF guard (https only, resolved addresses checked, pinned connection, redirects re-validated), extended with an image mode: accepts `image/jpeg|png|webp` only, 5 MB cap, 5 s timeout, content sniffed against the declared type. Stores in S3 at `{ownerId}/{uuid}.{ext}` exactly like presigned uploads. Errors reuse `ImportError` codes (422) plus `not_image`.
- **Fetch happens on Save, not on import** (no orphan objects for abandoned imports). The preview preselects `candidates[0]` and says "Photo found, will be saved" without loading any third-party image (preserving the existing no-hot-link-until-tapped rule). One "Show photo options" tap loads the thumbnails of all candidates (the preselected one marked) and the user taps to pick a different one. On Save the client calls `images/import` with the chosen URL, then `POST /recipes` with the returned `imageKey`. If the image fetch fails the recipe still saves without a photo and a snackbar says so. The user can still upload their own photo or remove it, as now.
- **Share target:** unchanged. The share carries only the URL; all finding happens server-side.

**Limits:** photos loaded by JavaScript only yield the JSON-LD/`og:image` guess; sites that block downloads drop that candidate silently at save time.

## 2. Delete a recipe from list and detail

The soft delete already exists (`DELETE /recipes/{id}`, 30-day TTL, `POST /recipes/{id}/restore`) and is reachable only from the edit screen. Add a Delete action to the recipe detail menu and to each card/row on `/recipes`. Confirm dialog, then an Undo snackbar that calls restore. No backend change.

## 3. Recipe list views

`/recipes` gets a header toggle: **large** (today's card grid), **small** (compact cards, more per row) and **list** (thumbnail, title, tags in a row). Persisted in `localStorage` key `nabbit.recipeView` (try/catch; default large). Same data and `/img/{imageKey}` URL for all three, so no backend change; small/list use CSS sizing and `loading="lazy"`. Search, tag chips, skeleton/error/empty states and the FAB work in every view. The per-item delete action from section 2 appears in all three.

## 4. One-tap add of a single ingredient

Each ingredient row on the recipe detail page gets an add button. It posts one item (the scaled ingredient in the existing `flour (480 ml)` format, category unset for item memory) to the target list using the existing `POST /lists/{id}/items`. Target list: `localStorage` `nabbit.lastListId` if that list still exists, otherwise the list named "Shopping" (auto-created if absent), otherwise the first list. There is no separate default-list setting. A snackbar "Added to {list name}" offers Undo (deletes the created item); the row shows an added check until the scale or unit mode changes. The existing whole-recipe "Add to list" dialog is unchanged and still updates `lastListId`.

## Testing and docs

- recipe-core/backend: unit tests for candidate ranking and filtering (fixtures with JSON-LD, og:image, DOM-only pages, hostile/oversized markup), image-mode safe-fetch (type, size, sniffing, SSRF cases), the `images/import` route (auth, owner scoping, rate limit, error codes).
- frontend: Jest for the preview candidate strip and Save sequencing (including image-fetch failure), delete + Undo on card/detail, view toggle persistence, single-ingredient add and Undo with list fallback.
- e2e: one Playwright flow per piece using the fixture fetch hook (extended to serve a test image).
- API suite: add `images/import` cases (400/401/422) to `tests/api/nabbit.frcol`.
- Update `backend`, `frontend` and root SYSDOCs (including the data-flow diagram note that Save may call `images/import`) and the endpoint table.

## Out of scope

Default-list setting, global quick-add outside recipes, image resizing/thumbnail generation, AI-based photo selection, headless-browser rendering of JavaScript pages.

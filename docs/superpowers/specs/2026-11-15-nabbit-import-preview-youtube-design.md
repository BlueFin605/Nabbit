# Nabbit: import preview, not-a-recipe guardrail, YouTube import

Date: 2026-11-15. Status: design approved, awaiting spec review.

Three pieces, delivered as one initiative on one branch (`feature/import-preview-youtube`):

- **A. Preview mode and action bar** (frontend). Independent.
- **B. Not-a-recipe guardrail** (backend + frontend error). Independent of A.
- **C. YouTube import** (backend + frontend banner). Builds on B.

## A. Preview mode and action bar (frontend)

After an import returns a draft, `/import` opens in **Preview**, not the editor.

- Preview reuses the saved-recipe view component in read-only mode: same layout, photo, ingredients, grouped or flat steps. No scaling in preview.
- **Edit** switches to the existing editor on the same draft; **Back to preview** returns, and edits show in the preview.
- **Action bar**: Save, Edit, Discard. Rendered twice (a sticky bar at the top and one at the bottom of the page), both driven by the same state. Save works from either mode and either bar. In edit mode the Edit button reads "Back to preview".
- **Discard** confirms only if the draft was edited; otherwise returns to the import page.
- Banners above the preview: the existing AI confidence badge; the YouTube linked-recipe banner (C); the Instagram "Recipe in a comment?" appender (unchanged).
- The photo candidate chooser stays visible in preview.
- Scope: the import preview and its edit mode only. Saved-recipe edit screens do not change.

## B. Not-a-recipe guardrail

The shared LLM prompt (all LLM paths: pasted text, Instagram captions, JS-shell pages, YouTube) gets an exit.

- Model output schema adds `isRecipe: boolean` and a short `reason`. `validateModelOutput` accepts `{isRecipe:false, reason}` as valid. Malformed output still keeps the heuristic draft, so the LLM never fails an import.
- `isRecipe: false` makes the import route answer **422 `not_a_recipe`** with the reason. No heuristic draft is returned.
- **Override:** the error offers "Import anyway", which resends with `forceRecipe: true`. That skips the check and returns the heuristic draft (or an LLM draft where one is possible). It counts against the same rate and LLM caps. Also offers "Paste text instead".
- Cost: one LLM call, same as any attempt; the existing 30/owner/day and app-wide daily caps apply unchanged. No second call.

## C. YouTube import

### Recognised URLs
`youtube.com/watch?v=`, `youtu.be/<id>`, `m.youtube.com`, `youtube.com/shorts/<id>`; https only; video id validated as 11 chars of `[A-Za-z0-9_-]`; tracking params (`si=` etc.) stripped from `sourceUrl`.

### Order of attempts
1. Fetch the watch page through `safe-fetch` (anonymous, no cookies, honest User-Agent). New `extract-youtube.ts` reads title, description and the caption track list from the embedded player data.
2. **Linked recipe first.** Take up to 3 https links from the description, skipping YouTube, social, shop and affiliate hosts (Instagram, TikTok, Amazon, `amzn.to`, `bit.ly` and similar). Each goes through the normal URL import path and its SSRF guard. The first that returns **structured schema.org Recipe data** wins: a structured draft with no LLM, steps keep groups as JSON-LD imports do today. Links without structured data are discarded.
3. Otherwise **transcript**: pick a manual English track, then auto-generated English, then the first track; fetch it and flatten to plain text (timestamps dropped). Send title + description + transcript to the LLM, with the description kept in full and the transcript truncated at a sentence boundary to a fixed cap.
4. No captions, under about 200 characters of text, a consent or bot wall, any fetch error, no LLM configured, or `YOUTUBE_AUTOFETCH=0` returns **422 `needs_text`**; the frontend asks the user to paste the transcript, which is then imported as text (the Instagram pattern).

### Rules
- The transcript path always uses the LLM (spoken prose is not heuristically parseable).
- **Flat steps**: the YouTube prompt and validation require flat steps; any group the model returns is flattened to strings. Only structured (JSON-LD/microdata) imports keep groups.
- B's not-a-recipe check applies to the transcript path.
- Response adds `source: 'linked-page' | 'transcript'` and, for a linked recipe, `videoUrl`. `sourceUrl` is the recipe page; the video link goes into the notes.
- Request takes optional `ignoreLinkedRecipe`. The preview banner "Imported from the recipe page linked in the video" has a "Use the video transcript instead" button that resends the same URL with it set.
- Kill switch `YOUTUBE_AUTOFETCH=0`, read per request; the CDK stack does not set it.
- Share target (Android) works unchanged: YouTube share links go to `/import`.

### Spike gate
`backend/scripts/spike-youtube.mjs`, run from CloudShell and the deployed import Lambda against several videos including `https://youtu.be/yk6tQfArMvw`. Checks: player data present, caption track fetchable, description links extractable. A no-go makes YouTube paste-only; A and B still ship.

## Testing
- Unit: URL recognition and id validation; description link filtering (host skips, 3-link cap); caption track selection and flattening; `isRecipe` schema; step flattening in the YouTube path; pre-LLM text checks.
- e2e (Playwright, fixture-fetch hook and stub LLM): linked recipe wins; transcript fallback; `needs_text` then paste; `not_a_recipe` then "Import anyway"; preview, Edit, back to preview, Save from the top bar and the bottom bar; Discard with confirmation.
- Run lint for touched packages before closing tickets.

## Docs and unverified
SYSDOCs (root data-flow diagram and key decisions, backend, frontend) are updated. Real YouTube fetching from Lambda and real Bedrock output are listed under Known gaps until Dean's smoke test.

## Delivery
Jira tickets on the Nabbit board under a new initiative. One branch, `feature/import-preview-youtube`. A and B are independent; C depends on B.

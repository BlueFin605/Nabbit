# E2E — Nabbit

What this is: a Playwright (TypeScript) browser suite exercising the real Angular PWA, the real backend handlers (via the local Express server) and LocalStack DynamoDB/S3 together, on a Pixel 7 viewport. Mirrors `BluefinWiki/e2e` (Playwright 1.63, no `webServer`: the stack is started separately), but brings its own stack script because the ports must not collide with other local projects.

Not folded into `../frontend/SYSDOC.md` or the backend docs because it spans both and owns its own lifecycle (stack up/down, fixtures).

## Where things are

- `tests/import-and-scale.spec.ts` — journey 1 (paste import: empty state, metric preview, heuristic banner, save), 2 (servings 4 to 6 scales client-side only; reload reverts; "Save as new size" persists), 3 (edit a quantity, metric text updates, persists; a second browser context saving a stale version gets the conflict prompt).
- `tests/lists-and-install.spec.ts` — journey 4 (add to list with one ingredient unticked, tap checks and moves down, double-tap deletes, Undo restores) and 5 (manifest with `share_target`, fetched through the request API, plus its icons; the install prompt itself is not tested).
- `tests/url-import.spec.ts` — journey 6: URL import of a JSON-LD page served by the fixture site, and a negative case proving the SSRF guard still rejects `https://127.0.0.1/`.
- `fixtures/api.ts` — `test` with an `api` fixture (bearer dev JWT for the fixed dev user `local-dev-user-id`; wipes that user's data before each test; `seedRecipe()`), `pancakes.txt` pasted-recipe fixture, `site/pasta.html` JSON-LD page.
- `scripts/stack.mjs` (`up`/`down`), `scripts/ports.mjs` (env-driven ports shared with `playwright.config.ts`), `scripts/static-server.mjs` (serves the built frontend with SPA fallback, and the fixture site).

## How the stack is wired

LocalStack 3 (`s3,dynamodb`) in a uniquely named container, `backend/scripts/init-local.mjs` for the table/bucket, the backend's local server with `NODE_ENV=development`, and the frontend built with the `e2e` configuration (auth disabled; its mock token is a JWT-shaped string whose `sub` the local backend reads). The URL-import journey uses the dev-server-only fixture hook, `backend/src/e2e-fixture-fetch.ts`: with `NODE_ENV=development`, `NABBIT_E2E_FIXTURE_FETCH=1` and a loopback `NABBIT_E2E_FIXTURE_ORIGIN`, `local.ts` gives `safeFetch` a resolver and transport that serve only `https://nabbit-fixtures.test/*` from the fixture site. `safe-fetch.ts` and the Lambda handlers are untouched and never read the flag (unit-tested in `backend/test/e2e-fixture-fetch.test.ts`).

## Running

See `README.md`.

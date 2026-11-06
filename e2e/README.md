# Nabbit E2E (Playwright)

Real-browser Playwright suite (Pixel 7 viewport, Chromium) for the Angular PWA against the local dev stack. See `SYSDOC.md` for what is covered and how it is wired.

## Prerequisites

Docker (for LocalStack), Node 24. From the repo root:

```
npm install
npx playwright install chromium
```

## Run

```
npm run stack:up -w e2e     # LocalStack container -> table/bucket -> built frontend + fixture site + backend
npm run e2e -w e2e          # the suite (headless)
npm run stack:down -w e2e   # kills what stack:up started and removes its LocalStack container
```

`stack:up` starts only what it names: container `nabbit-e2e-localstack`, plus Node processes recorded in `e2e/.stack/state.json`; `stack:down` removes exactly those. Default ports (override with env, e.g. `E2E_BACKEND_PORT=3020`; use the same env for all three commands): LocalStack `4577`, backend `3010`, frontend `4210`, fixture site `4211`. They avoid the usual dev ports (3000, 4566, 5173) so the suite can run beside Aspire or other projects. Logs: `e2e/.stack/*.log`.

Run one spec: `npx playwright test -w e2e url-import` (or `cd e2e && npx playwright test url-import`). Typecheck: `npm run typecheck -w e2e`.

## Notes

- The frontend is built with the `e2e` Angular configuration: the dev environment (auth disabled, fixed dev user) pointing at the e2e backend port. `stack:up` generates `frontend/src/environments/environment.e2e.ts` (git-ignored) and serves the build from `e2e/.dist`. Rebuilt on every `stack:up`.
- One shared dev user, so tests run serially (`workers: 1`) and each test starts by deleting that user's recipes and lists through the API.
- Seeded recipes are POSTed directly; only the import journeys use `POST /recipes/import`, which is rate limited to 30 per hour per user (a loopback-rejection attempt counts too). A run uses 3; restart the stack for a fresh counter after ~10 runs.
- Not wired into `build.yml`: it needs Docker, a ~1 GB LocalStack image and a Playwright browser download. It could run headless without secrets, but would slow every push, so it stays a manual/local check for now.

# Backend — Nabbit

What this is: Node 24 + TypeScript Lambda code behind an API Gateway HTTP API. The build bundles each `src/handlers/*.ts` with esbuild (CommonJS) to `dist/<name>/index.js`: `api` (router plus recipes, images, lists; deliberately no import route), `import` (the import route only, so its own reserved concurrency caps it) and `health` (built, but no deployed route points at it). Depends on `@nabbit/recipe-core`.

## Where things are

- `src/router.ts` — tiny router: `route(method, pattern, handler)` with `{param}` segments; `HttpError(status, message)` becomes `{error}` JSON; 401 when the authorizer `sub` claim is missing. Route modules self-register on import. Paths with empty segments (`//`, trailing `/`) are 404 so normalization cannot alias routes. The import route is registered only by `handlers/import.ts` and the local dev server (`local.ts`), never by `handlers/api.ts`.
- `src/routes/` — `recipes.ts`, `images.ts`, `lists.ts`, `import.ts`. The header comment of each is the endpoint contract.
- `src/db.ts` — the `Db` interface (get, conditional put, delete, query by prefix, atomic counter, atomic `bumpItemMemory`), key builders and the DynamoDB implementation; `db-memory.ts` is the unit-test double (`setDb`). Key layout: root `SYSDOC.md`.
- `src/import/` — `safe-fetch.ts`, `extract-structured.ts`, `extract-text.ts`, `import-error.ts`.
- `src/local.ts`, `src/local-adapter.ts` — Express dev server wrapping the same handlers; `src/e2e-fixture-fetch.ts` — dev-only fixture hook for e2e (`../e2e/SYSDOC.md`).
- `scripts/seed-local.mjs` (`npm run seed`) seeds a dev user's sample recipes and shopping list through the HTTP API (idempotent, `--reset`; see README "Running locally"); `test/seed-local.test.ts` runs it against the real handlers so it cannot drift from the route validators. `scripts/init-local.mjs` creates the local table and image bucket; `scripts/build.mjs` is the bundler.
- `test/` — Vitest unit and handler tests. `tests/api/` — the FullyRested API suite.

## HTTP endpoints

All need a JWT, except health. Errors are `{error}`. Another owner's record is always 404. The 401 body depends on where it is raised: the local server (and the handler itself, when the authorizer `sub` claim is missing) returns `{error:'unauthorized'}`; in AWS the API Gateway JWT authorizer rejects first with its own `{"message":"Unauthorized"}`, so clients must not rely on the body.

**Router-level errors** (any route): 400 `invalid_json` (body is not JSON), 400 `too_large` (see Limits), 404 `not_found` (no matching route, a path parameter over 100 characters, or a path with an empty segment such as `//` or a trailing `/`), 500 `internal` (unexpected exception, logged, no detail returned).

**Limits.** Path parameters longer than 100 characters never match a record (404, so oversized sort keys never reach DynamoDB; ids containing `#` or `/` are just unknown ids inside the caller's own partition). A recipe or list whose serialized JSON exceeds 350 KB is rejected with 400 `{error:'too_large'}` (DynamoDB's item limit is 400 KB). Also 400: `GET /items/suggest` with `q` over 100 characters.

| Method and path | Success | Errors |
|---|---|---|
| `GET /health` (local server only) | 200 `{status:'ok'}`, no auth | |
| `GET /recipes?q=&tag=` | 200 summaries (soft-deleted excluded) | |
| `POST /recipes` | 201 recipe (body is a draft's `recipe`) | 400 |
| `GET /recipes/{id}` | 200 | 404 |
| `PUT /recipes/{id}` | 200, full replace, body carries `version` | 400, 404, 409 `version_conflict` |
| `DELETE /recipes/{id}` | 204, soft delete (30-day TTL) | 404, 409 |
| `POST /recipes/{id}/restore` | 200 | 404 (unknown, other owner's, or not deleted), 409 |
| `POST /recipes/images` | 200 `{imageKey,url,fields,expiresIn}` presigned POST; jpeg/png/webp, 5 MB | 400 |
| `POST /recipes/import` | 200 `{draft, imageUrl?}`; body `{url}` xor `{text}` (text max 50,000 chars); saves nothing | 400, 422 `{error: <import code>}`, 429 `rate_limited` + `retry-after` |
| `GET /lists` | 200 summaries | |
| `POST /lists` | 201 (max 50 lists) | 400 |
| `GET /lists/{id}` | 200 | 404 |
| `PUT /lists/{id}` | 200, body `{name, items, version}` | 400, 404, 409 |
| `DELETE /lists/{id}` | 204, hard delete | 404 |
| `POST /lists/{id}/items` | 201 list; `{name, category?}` or `{items:[...]}` (max 500 items) | 400, 404, 409 |
| `PATCH /lists/{id}/items/{itemId}` | 200 list (`checked`, `name`, `category`) | 400, 404, 409 |
| `DELETE /lists/{id}/items/{itemId}` | 200 list | 404, 409 |
| `GET /items/suggest?q=` | 200, up to 8 `{name, category}` from item memory, most used first | 400 (`q` over 100 chars) |

Item names written to a list are remembered (`MEM#`) with their category, which drives suggest and sticky aisle grouping. Memory is updated with one atomic `UpdateItem` (`ADD uses :n SET category, updatedAt`) so concurrent adds never lose increments; a category change on an existing item adds 0 to `uses`.

## Import pipeline

`routes/import.ts`: validate the body, increment the rate counter, then either `extractFromText` (pasted text) or `safeFetch(url)` followed by `extractStructured` (JSON-LD, then microdata), falling back to `htmlToText` plus the text heuristic. The draft's `confidence` is `structured` or `heuristic`.

- **Rate limit**: 30 per owner per clock hour (`RATE#import#{epoch hour}`, 2 h TTL), incremented before any fetch so failures count. It is a fixed bucket, so a burst can reach 60 across an hour boundary. Reserved Lambda concurrency (see `../infrastructure/SYSDOC.md`) is the hard cap.
- **safe-fetch**: https only; the hostname is resolved and any private, loopback, link-local or unparseable address (v4, v6, mapped) blocks the whole host; the connection is pinned to the validated IPs (tried IPv4 first, falling back to the next on connect failure, since Lambda has no IPv6 egress) with TLS checked against the hostname (defeats DNS rebinding); any upstream status outside 200-599 is mapped to 502; up to 4 redirects, each re-validated; 5 s timeout; 2 MB cap; HTML only. Failures are `ImportError` codes, all returned as 422: `bad_url`, `blocked_address`, `too_large`, `timeout`, `bad_status`, `not_html`, `too_many_redirects`.
- **Extractors** parse HTML and never run it, with node, depth and size budgets against hostile pages.

## Auth and running

In AWS the JWT authorizer supplies `sub`. The local server decodes (does not verify) a bearer JWT's `sub`, or, when `NODE_ENV=development`, accepts `X-Dev-Sub`. Local stack and run commands are in the root `README.md`. Tests: `npm test -w backend`, `npm run typecheck -w backend`.

## DynamoDB adapter tests

Handler tests use the in-memory double (`src/db-memory.ts`). `test/db-dynamo.test.ts` drives the real `createDynamoDb` with a stub DocumentClient and asserts the generated commands (condition expressions, `ADD` counters, Query pagination, Delete, `ConditionalCheckFailedException` to `ConditionFailedError`), and pins the semantics the double mirrors (undefined values dropped, counters preserve other attributes, queries sorted by sk). The double's remaining differences (no 400 KB item limit, no 1 MB page limit/pagination, no expression validation or TTL expiry) are listed in its header comment. `test/db-localstack.test.ts` runs the adapter against real DynamoDB semantics and is skipped unless `NABBIT_LOCALSTACK_ENDPOINT` is set; start LocalStack, run `init-local.mjs` with `AWS_ENDPOINT_URL` and `TABLE_NAME`, then `NABBIT_LOCALSTACK_ENDPOINT=... NABBIT_LOCALSTACK_TABLE=... npx vitest run test/db-localstack.test.ts` from `backend/` (exact commands are in the file header).

## API suite

`tests/api/nabbit.frcol` (FullyRested; 61 requests in five folders: health, recipes, lists, import, import-rate-limit) checks the HTTP contract: status plus JSON Schema per request, including 400/401/404/409/422/429 cases. It needs LocalStack-backed DynamoDB and S3 (the dev server has no in-memory mode). URL imports are tested only with rejected addresses so the suite never reaches the internet. The `production` environment is for the owner to run deliberately; the 401 body there is API Gateway's `{"message":"Unauthorized"}`, not the local `{error:'unauthorized'}`, and the `health` folder fails there because no `/health` route is deployed.

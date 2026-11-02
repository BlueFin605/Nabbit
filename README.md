# Nabbit

Recipe import and scaling app: an Angular PWA frontend, a Node.js Lambda backend, and a shared recipe-core library.

## Layout

- `shared/recipe-core` - shared recipe parsing/scaling code (`@nabbit/recipe-core`, see `shared/recipe-core/SYSDOC.md`)
- `backend` - Node 24 + TypeScript Lambda handlers, one per `src/handlers/<name>.ts` (see `backend/SYSDOC.md`)
- `frontend` - Angular PWA (see `frontend/SYSDOC.md`)
- `infrastructure` - C# CDK app (see `infrastructure/SYSDOC.md`)
- `e2e` - Playwright browser suite (see `e2e/README.md`)

Architecture, the data model and key decisions are in `SYSDOC.md`.

## Configuration

Copy `config.example.json` and set `prefix`, `region`, `environment` and `domain` for your deployment. Optional keys: `hostedZoneId` (import the DNS zone instead of looking it up), `importReservedConcurrency` (default 5), `apiCodePath` and `importCodePath` (override the Lambda bundle locations).

## Build

```
npm ci
npm run lint
npm test
npm run typecheck
npm run build -w backend
npm run build -w frontend
```

The backend build bundles each handler with esbuild to `backend/dist/<name>/index.js` (CommonJS, node24).

## Deploying

Deployment is handled by a private repo, not this one, and is manual: it builds the backend and frontend with the deployment config, runs `cdk deploy` for the infrastructure (see `infrastructure/SYSDOC.md`), and syncs `frontend/dist/browser` to the site bucket. CI here (`.github/workflows/build.yml`) only typechecks, lints, tests and builds.

## Tests

- Unit: `npm test` runs every workspace (Vitest for `shared/recipe-core` and `backend`, Jest for `frontend`).
- API: the FullyRested suite, below.
- Browser: the Playwright suite, below.
- Before merging: `npm run lint` and `npm run typecheck`.

## Running locally

Prerequisites: Docker, .NET 10 SDK, Node 24. From the repo root:

```
npm ci
npm run dev
```

`npm run dev` starts an Aspire AppHost (`aspire/Nabbit.AppHost`) that runs LocalStack (DynamoDB + S3, :4566), Cognito Local (:9229) and MailHog (UI :8025), then a one-shot `init-db` step (creates the `nabbit-local-data` table with the same `pk`/`sk` key schema and TTL as the CDK table, plus the image bucket), then the backend (`npm run dev -w backend`, Express on :3000, same Lambda handlers as production) and, once it exists, the frontend (`ng serve` on :5173 with `NG_APP_API_BASE_URL=http://localhost:3000`).

Check it: `curl localhost:3000/health` returns `{"status":"ok"}`.

Without Docker you can run just the backend: `npm run dev -w backend` (port 3000; `/health` needs no AWS).

Auth locally: send a Cognito-style JWT as `Authorization: Bearer <jwt>` (the `sub` claim becomes `ownerId`; the signature is not checked), or, because `NODE_ENV=development`, just send `X-Dev-Sub: <ownerId>`. The `X-Dev-Sub` header is ignored in any other environment.

## API tests

The backend's HTTP API is covered by a FullyRested collection at `backend/tests/api/nabbit.frcol` (health, recipes, lists, import, import-rate-limit folders; every request has a status plus JSON Schema check, with 400/401/404/409/422/429 cases). It needs the real local stack (DynamoDB + S3 via LocalStack) because the dev server has no in-memory mode.

```
npm run dev                      # Aspire: LocalStack + backend on :3000 (or start LocalStack, `npm run init-local -w backend`, then `npm run dev -w backend` with NODE_ENV=development and the AWS_* / TABLE_NAME / IMAGE_BUCKET env from aspire/Nabbit.AppHost/Program.cs)
fullyrested run -c backend/tests/api/nabbit.frcol --all -e local
```

(or `run` via the FullyRested MCP / desktop app). The `local` environment sends unsigned dev JWTs for three fixed users (A, B for cross-owner cases, and a rate-limit user). The `import-rate-limit` folder burns that user's 30/hour import quota, so it asserts the 429 and can be re-run freely. URL imports are only tested for rejected addresses (`blocked_address`, `bad_url`) so the suite never reaches the internet. The `production` environment uses secret references `token`, `otherToken` and `rlToken` (Cognito ID tokens for three users; set with `fullyrested secret set`) and a placeholder `baseUrl`; running it is the maintainer's call.

## E2E tests

A Playwright browser suite lives in `e2e/` (own stack on separate ports; see `e2e/README.md`): `npm run stack:up -w e2e`, `npm run e2e -w e2e`, `npm run stack:down -w e2e`.

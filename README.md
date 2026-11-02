# Nabbit

Recipe import and scaling app: an Angular PWA frontend, a Node.js Lambda backend, and a shared recipe-core library.

## Layout

- `shared/recipe-core` - shared recipe parsing/scaling code (`@nabbit/recipe-core`)
- `backend` - Node 24 + TypeScript Lambda handlers, one per `src/handlers/<name>.ts`
- `frontend` - Angular PWA (see `frontend/SYSDOC.md`)

## Configuration

Copy `config.example.json` and set `prefix`, `region`, `environment` and `domain` for your deployment.

## Build

```
npm ci
npm run lint
npm test
npm run build -w backend
```

The backend build bundles each handler with esbuild to `backend/dist/<name>/index.js` (CommonJS, node24).

Deployment is handled by the private Home repo, not this one. CI here only builds and tests.

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

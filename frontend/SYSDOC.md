# Frontend — Nabbit

What this is: the Angular 22 installable PWA (standalone components, signals, zoneless, Angular Material, Jest). Served by `ng serve` locally (via Aspire) and as static files on S3 + CloudFront in production. Mirrors `BluefinWiki/frontend` conventions.

## Where things are

- `src/app/core/auth/` — Cognito Hosted UI sign-in (auth code + PKCE S256, no client secret): `cognito-oauth.ts` (authorize URL, token exchange), `auth.ts` (session/user signals, token storage, refresh, sign-out), `auth-guard.ts` (signed-out users go to `/signin`; the wanted URL is remembered so a share-target `/import?...` survives sign-in), `auth-interceptor.ts` (adds `Authorization: Bearer <id token>` to calls to the API origin only, one refresh-and-retry on 401, else sign out).
- `src/app/core/api/` — `ApiClient` (a typed method per backend route: recipes, images presign/upload, import, lists, items, suggest) and `api.types.ts` (response shapes; domain types come from `@nabbit/recipe-core`). No API data is cached by the service worker.
- `src/app/features/` — lazy routes `/recipes`, `/recipes/:id`, `/lists`, `/import` (all behind the guard), plus `/signin` and `/callback`. Screens are placeholders until later tickets.
- `public/manifest.webmanifest` — name, `start_url: /recipes`, standalone, 192/512/maskable icons, `share_target` (GET `/import` with `title`, `text`, `url`).
- `ngsw-config.json` — app-shell and asset caching only (production builds).
- `scripts/build-env.mjs` — writes `src/environments/environment.production.ts` from env vars; runs as the `prebuild` hook.
- `scripts/generate-icons.mjs` — regenerates the placeholder PNG icons (`npm run icons -w frontend`).

## Build-time configuration

`npm run build -w frontend` reads `NG_APP_API_BASE_URL`, `NG_APP_COGNITO_REGION`, `NG_APP_COGNITO_USER_POOL_ID`, `NG_APP_COGNITO_CLIENT_ID`, `NG_APP_COGNITO_DOMAIN` (host only, no scheme) and `NG_APP_COGNITO_REDIRECT_URI`. All six set: validated (https, non-local API) and baked in. None set: a placeholder environment is written so CI compiles (not deployable). Some set: the build fails. `environment.production.ts` is committed as the placeholder; the build rewrites it.

Output is `dist/browser/` (`index.html`, `ngsw.json`, hashed chunks), which is what Home's Deploy Nabbit workflow locates and syncs.

Local dev (`ng serve`, `environment.ts`): API `http://localhost:3000`, auth disabled with a mock token.

## Commands

- `npm test -w frontend` (Jest), `npm run lint -w frontend` (`ng lint`), `npm run typecheck -w frontend`, `npm run build -w frontend`.

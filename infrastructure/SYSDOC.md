# Infrastructure — Nabbit

What this is: the AWS CDK (C#, .NET 10) app that deploys Nabbit. Deploys are manual (Home's `deploy-infra.ps1`), never from a pipeline.

## Where things are

- `src/Infrastructure/Program.cs` — entry point; reads the `nabbit` section of `config.json` (`-c configFile=...`, default `../config.json`) and creates both stacks.
- `src/Infrastructure/NabbitConfig.cs` — config model (`prefix`, `region`, `environment`, `domain`, optional `hostedZoneId`, `importReservedConcurrency`, `apiCodePath`, `importCodePath`).
- `src/Infrastructure/Stacks/NabbitStack.cs` — the single stack: DynamoDB, Cognito, S3 buckets, CloudFront, HTTP API, Lambda, Route53 records, API certificate.
- `src/Infrastructure/Stacks/NabbitCertStack.cs` — tiny us-east-1 companion holding the one certificate (SPA + `auth.` domains) that CloudFront and the Cognito custom domain require. Cross-region references link it to `NabbitStack`.
- `test/Infrastructure.Tests` — `dotnet test src/Infrastructure.slnx` runs CDK assertions (TTL + PITR, public access blocked, JWT authorizer on every route, no wildcard bucket policy, CORS (API and image bucket), auth domain, DNS).

## Key decisions

- **Images**: private bucket, served only through the SPA CloudFront distribution at `{domain}/img/*` (OAC; a viewer-request function strips the `/img` prefix). Object keys are `{ownerId}/{uuid}`; the API writes them, nothing is signed. Chosen over signed URLs for simplicity and caching.
- **SPA**: separate private bucket behind CloudFront (OAC); 403/404 fall back to `/index.html`.
- **Auth**: Cognito app client (public, authorization-code + PKCE) allows callback URLs `https://{domain}/`, `/auth/callback` and `/callback` (the frontend's redirect URI, same as Home's `NG_APP_COGNITO_REDIRECT_URI`); logout URL is `https://{domain}/`.
- **API**: HTTP API at `api.{domain}`, JWT authorizer (Cognito user pool client) on `$default` and `/{proxy+}`. CORS allows only `https://{domain}` with credentials. The image bucket (only) has a CORS rule: origin `https://{domain}`, `POST`, headers `*`, max age 3000, so the browser can upload via presigned POST. One Lambda (`backend/dist/api`, node24, arm64) gets `TABLE_NAME`, `IMAGE_BUCKET`, `IMAGE_BASE_URL`, `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `ALLOWED_ORIGIN`.
- **DNS**: zone is the parent of `domain`; looked up by name, or imported when `hostedZoneId` is set (the example config sets a placeholder so `cdk synth` runs without credentials).
- **Retention**: table, user pool and buckets use `RETAIN`.
- **Import Lambda**: `POST /recipes/import` has its own route (more specific than `/{proxy+}`, same JWT authorizer) and its own Lambda (`backend/dist/import`, `importCodePath`), with `ReservedConcurrentExecutions = importReservedConcurrency` (default 5) so an import flood cannot exhaust the account. It only gets table access. Note the account's unreserved concurrency must stay at 10 or more, so a new account may need a limit increase before deploy. The per-user hourly limit (30) is a DynamoDB counter `RATE#import#{hour}` (TTL 2 h), written by the import handler.

- **No health route**: `backend/src/handlers/health.ts` is built but not wired to any route or Lambda here; `/health` exists only on the local dev server.
- **Table keys**: `pk`/`sk` with TTL attribute `ttl`; the item layout is in the root `SYSDOC.md`.

## Running

Build the backend first (`npm run build` at repo root), then from this folder:
`cdk synth -c configFile=../config.example.json` (needs `CDK_DEFAULT_ACCOUNT` set; dummy credentials are enough with `hostedZoneId` set).

# Infrastructure — Nabbit

What this is: the AWS CDK (C#, .NET 10) app that deploys Nabbit. Deploys are manual (Home's `deploy-infra.ps1`), never from a pipeline.

## Where things are

- `src/Infrastructure/Program.cs` — entry point; reads the `nabbit` section of `config.json` (`-c configFile=...`, default `../config.json`) and creates both stacks.
- `src/Infrastructure/NabbitConfig.cs` — config model (`prefix`, `region`, `environment`, `domain`, optional `hostedZoneId`, `importReservedConcurrency`, `llmModelId` (optional Bedrock model or inference-profile id; unset = LLM parser off), `apiCodePath`, `importCodePath`).
- `src/Infrastructure/Stacks/NabbitStack.cs` — the single stack: DynamoDB, Cognito, S3 buckets, CloudFront, HTTP API, Lambda, Route53 records, API certificate.
- The us-east-1 certificate (SPA domain) for CloudFront is not a CDK resource: the deploy script (kept outside this repo) finds or requests it in ACM and passes `-c globalCertArn=...`, which `Program.cs` imports.
- `test/Infrastructure.Tests` — `dotnet test src/Infrastructure.slnx` runs CDK assertions (TTL + PITR, public access blocked, JWT authorizer on every non-OPTIONS route, no route can match OPTIONS, least-privilege IAM for import and API roles, no wildcard bucket policy, CORS (API and image bucket), auth domain, DNS).

## Key decisions

- **Images**: private bucket, served only through the SPA CloudFront distribution at `{domain}/img/*` (OAC; a viewer-request function strips the `/img` prefix). Object keys are `{ownerId}/{uuid}.{ext}`; the API (presigned POST) and the import Lambda write them, nothing is signed. Chosen over signed URLs for simplicity and caching.
- **SPA**: separate private bucket behind CloudFront (OAC); 403/404 fall back to `/index.html` with status 200 (distribution-wide; see the deferred note below).
- **Auth**: Cognito app client (public, authorization-code + PKCE) allows callback URLs `https://{domain}/`, `/auth/callback` and `/callback` (the frontend's redirect URI, same as Home's `NG_APP_COGNITO_REDIRECT_URI`); logout URL is `https://{domain}/`.
- **API**: HTTP API at `api.{domain}`, JWT authorizer (Cognito user pool client) on `/{proxy+}` (GET, POST, PUT, PATCH, DELETE), `POST /recipes/import` and `POST /recipes/images/import`. There is deliberately no `$default` route and no OPTIONS route: a `$default` route with an authorizer also matches OPTIONS, which would 401 the browser's unauthenticated preflight, whereas with no OPTIONS-matching route API Gateway answers preflight itself from the CORS configuration (unproven until the first real deploy). CORS allows only `https://{domain}` with credentials. The image bucket (only) has a CORS rule: origin `https://{domain}`, `POST`, headers `*`, max age 3000, so the browser can upload via presigned POST. One Lambda (`backend/dist/api`, node24, arm64) gets `TABLE_NAME`, `IMAGE_BUCKET`, `IMAGE_BASE_URL`, `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `ALLOWED_ORIGIN`.
- **DNS**: zone is the parent of `domain`; looked up by name, or imported when `hostedZoneId` is set (the example config sets a placeholder so `cdk synth` runs without credentials).
- **Retention**: table, user pool and buckets use `RETAIN`.
- **Import Lambda**: `POST /recipes/import` and `POST /recipes/images/import` each have their own route (more specific than `/{proxy+}`, same JWT authorizer) and its own Lambda (`backend/dist/import`, `importCodePath`), with `ReservedConcurrentExecutions = importReservedConcurrency` (default 5) so an import flood cannot exhaust the account. Its role may `dynamodb:UpdateItem` on the table (the rate counter) and `s3:PutObject` (GrantPut) on the image bucket (it stores images fetched for `images/import`), nothing else; it gets `TABLE_NAME` and `IMAGE_BUCKET`. When `llmModelId` is set it also gets `LLM_MODEL_ID` and `bedrock:InvokeModel` scoped to that model's ARN(s); the API Lambda gets no Bedrock access, and Bedrock model access must be enabled in the account beforehand. The per-user daily LLM cap (30) is the counter `RATE#llm#{date}`. The API role likewise has only `s3:PutObject` on the image bucket (presigned uploads), no read/delete. Note the account's unreserved concurrency must stay at 10 or more, so a new account may need a limit increase before deploy. The per-user hourly limit (30) is a DynamoDB counter `RATE#import#{hour}` (TTL 2 h), written by the import handler.

- **Deferred: public image URLs** (accepted for MVP). Images are public capability URLs, `/img/{sub}/{uuid}.ext` through CloudFront: the UUID is unguessable but anyone holding a URL can fetch it, and the key exposes the owner's Cognito `sub`. Alternatives if this matters later: CloudFront signed URLs/cookies, or an opaque owner hash in the key.
- **Deferred: missing image returns HTML 200** (accepted for MVP). The distribution-wide 403/404 to `/index.html` 200 rule also applies to `/img/*`, so a missing image returns the SPA shell with status 200. Fix idea: apply the SPA fallback to the default behaviour only, e.g. a viewer-request function rewriting extensionless paths, and drop the distribution-wide error responses.
- **No health route**: `backend/src/handlers/health.ts` is built but not wired to any route or Lambda here; `/health` exists only on the local dev server.
- **Table keys**: `pk`/`sk` with TTL attribute `ttl`; the item layout is in the root `SYSDOC.md`.

## Running

Build the backend first (`npm run build` at repo root), then from this folder:
`cdk synth -c configFile=../config.example.json` (needs `CDK_DEFAULT_ACCOUNT` set; dummy credentials are enough with `hostedZoneId` set).

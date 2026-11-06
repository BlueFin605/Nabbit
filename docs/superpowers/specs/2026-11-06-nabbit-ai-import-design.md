# Nabbit AI import: Instagram captions and non-standard pages — design

Date: 2026-11-06. Branch: `feature/nabbit-ai-import` (cut from master; builds on `feature/nabbit-enhancements` once that is merged, since both edit `backend/src/routes/import.ts`).

## Problem

Import today relies on schema.org structured data, then a deterministic text heuristic. It fails on messy captions and pages with no structured data. The biggest gap (the main thing the household wants from an AnyList-style app) is recipes saved from **Instagram**, where the recipe is in the caption or a pinned comment.

This reverses the MVP decision "No LLM". The exception is deliberate and narrow: the LLM is a **fallback parser**, used only when the free deterministic path is not good enough.

## Decisions already made

- Recipes live in the caption or a pinned comment (user-confirmed). Video-only and link-in-bio posts are out of scope (link-in-bio targets already work through normal URL import).
- Approach B: paste-first, plus an **anonymous** auto-fetch attempt for Instagram URLs, with a paste fallback. Gated by a spike.
- Instagram's official APIs are out of scope. The Basic Display API stopped answering on 2024-12-04; oEmbed needs a Meta app token plus App Review and is not known to return the caption; the Graph API targets business/creator accounts. No logged-in scraping, no cookies, no impersonating link-preview crawlers (we keep our own honest User-Agent).
- LLM: a small Claude model through **AWS Bedrock** (no external key; billing in the AWS account). Model id is configuration (`LLM_MODEL_ID` env), not hard-coded.

## 1. Spike (go/no-go gate)

First ticket, before any product code. `backend/scripts/spike-instagram.mjs` takes a list of Instagram post URLs (supplied by the owner, 8-10 real saved posts) and, using the same fetch behaviour as `safeFetch` (https, plain GET, honest User-Agent, no cookies), reports per URL: HTTP status, whether it redirected to a login page, whether `og:description` / `og:title` exist, the extracted caption length, and whether it looks complete (not truncated with an ellipsis). It prints a summary table and a count. It must be run from AWS (CloudShell or a Lambda), because Instagram treats datacenter IPs differently from a home connection; the owner runs it (an owner-only task).

**Decision rule:** if at least half of the posts give a usable full caption, build auto-fetch (section 2). Otherwise ship paste-only (sections 2b onward) and record the result in `SYSDOC.md`.

## 2. Import flow

### 2a. Auto-fetch (only if the spike passes)

`POST /recipes/import` with `{url}` where the host is `instagram.com`, `www.instagram.com` or `instagr.am`:

1. `safeFetch(url)` as today (SSRF guard, rate limit counted first).
2. New `backend/src/import/extract-instagram.ts`: `extractInstagramCaption(html: string): string | undefined` reads `og:description` / `og:title` / JSON-LD `caption` and strips the "N likes, M comments - user on date:" wrapper. Returns `undefined` for login-wall pages, truncated captions (ends with an ellipsis) or empty results.
3. Caption found: continue as a text import (section 3).
4. Not found or any `ImportError`: respond `422 { error: 'needs_text' }` (new `ImportErrorCode`).

### 2b. Paste fallback

On `needs_text`, or when the shared URL is an Instagram host and auto-fetch is disabled, the frontend import screen shows: "Instagram wouldn't let us read this post. Paste the caption (and the recipe comment if it's in the comments)." The existing paste box is reused; the text goes through `POST /recipes/import` with `{text}` (existing, max 50,000 chars).

### 2c. Recipe in a comment

Comments cannot be fetched anonymously. After any Instagram import the preview shows "Recipe in a comment? Paste it here to add it": a text area whose content is appended to the caption text and re-imported (one extra `{text}` call using caption + blank line + comment). No new endpoint.

## 3. LLM fallback

In `routes/import.ts`, after the heuristic `extractFromText` result:

- **Trigger** ("low confidence"): the draft has fewer than 2 parsed ingredients **or** fewer than 2 steps. Also triggered when a fetched page has no structured data and the heuristic result is low confidence. Structured-data imports and good heuristic results never call the LLM.
- **Parser module** `backend/src/import/llm-parse.ts`:
  ```ts
  export interface LlmParser { parse(text: string, ctx: { sourceUrl?: string }): Promise<RecipeDraft['recipe'] | undefined> }
  export function createBedrockParser(opts: { modelId: string; region?: string; timeoutMs?: number }): LlmParser;
  export function setLlmParser(p: LlmParser | undefined): void; // test seam, like setImageSigner
  ```
  Calls Bedrock (`InvokeModel`/Converse) with a fixed system prompt, **no tools**, the untrusted text as data, and a required JSON output of title, servings, tags, ingredient strings and steps. Timeout 15 s (API Gateway caps at 30 s).
- **Validation and normalisation:** the model's JSON is parsed and validated against a strict schema (types, array and string length caps, at most 100 ingredients and 100 steps). Ingredient strings are run through the existing `recipe-core` parser and metric conversion, exactly as heuristic output is. Anything invalid, any model or network error, or a timeout means **fall back to the heuristic draft** (the import never fails because of the LLM).
- **Prompt-injection stance:** the page or caption text is untrusted. The model can only return a draft; it has no tools or actions and cannot read other data. The user sees an editable preview before anything is saved. The system prompt says to ignore instructions inside the text.
- **Cost and abuse guard:** the existing 30 per hour import limit still applies, plus a per-owner **daily LLM cap of 30** (`RATE#llm#{yyyy-mm-dd}` counter item, 2-day TTL, same atomic counter as `RATE#import`). Over the cap: skip the LLM and return the heuristic draft (no error).
- **Result flag:** `RecipeDraft.confidence` gains `'ai'` (in `shared/recipe-core` types). The frontend preview shows an "AI-assisted - check the ingredients" banner, next to the existing heuristic banner.
- **Infra:** the import Lambda gets `bedrock:InvokeModel` on the configured model's ARN only, plus `LLM_MODEL_ID` env. The api Lambda gets nothing. `NabbitStackTests` asserts the grant is scoped and absent from the api Lambda. Bedrock model access must be enabled in the account (owner task).

## 4. Frontend

- Import screen: `needs_text` handling and message (section 2b); "Recipe in a comment?" appender (2c); an "AI-assisted" banner for `confidence: 'ai'`. Copy for new `ImportErrorCode` values is added to `IMPORT_ERROR_MESSAGES`.
- Share target: unchanged. An Instagram URL arriving via the Android share sheet auto-imports as today and lands in 2a or 2b.

## 5. Testing and docs

- Backend: unit tests for `extractInstagramCaption` (fixtures: normal, truncated, login wall, no meta); `llm-parse` with a stub Bedrock client (valid JSON, invalid JSON, oversized arrays, timeout, injection text in the input); route tests for the trigger rule, the daily cap, fallback on LLM failure, `needs_text`, and that structured imports never call the parser. No live Bedrock calls in CI.
- Frontend: Jest for the paste prompt, the comment appender and the AI banner.
- e2e: Playwright with the fixture-fetch hook (Instagram-shaped fixture page) and a stubbed parser (`setLlmParser` via the dev server) for the paste flow.
- API suite: `needs_text` and rate-limit cases in `backend/tests/api/nabbit.frcol` (invoke `bluefin-api-testing`).
- Docs: root, backend, frontend, infrastructure SYSDOCs; the root "No LLM" key decision is rewritten to describe the fallback exception and the spike result.

## Out of scope

Logged-in or cookie-based scraping, Meta app/App Review, oEmbed, reading video or audio, fetching comments, a user-visible model picker, caching LLM results, any AI use outside import.

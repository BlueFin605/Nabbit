/**
 * Recipe import (owner from the JWT; NOTHING is saved, the client previews the draft then POSTs /recipes):
 *   POST /recipes/import  body `{ url }` XOR `{ text }` (text <= 50,000 chars)
 *     200 { draft: RecipeDraft, imageUrl?, candidates?: string[] }  (url imports only; imageUrl === candidates[0])
 *     400 { error } invalid body        422 { error: <ImportError code> }
 *     429 { error: 'rate_limited' } + retry-after (seconds)
 *   POST /recipes/images/import  body `{ url }` (https) -> 200 { imageKey }: downloads the image through the SSRF guard
 *     and stores it at {ownerId}/{uuid}.{ext}; 400 bad url, 422 { error: <ImportError code> } (incl. not_image), 429 as above.
 *     Shares the import rate limit (same counter). Registered on the import Lambda only.
 * LLM fallback: low-confidence text drafts try the LLM parser, max 30/owner/UTC day (RATE#llm#{date}, ttl 2d),
 * plus an app-wide cap per UTC day (pk=GLOBAL, same sk; LLM_GLOBAL_DAILY_LIMIT, default 300, read per request)
 * so many accounts cannot multiply the spend. The global counter is only bumped once the owner is under their cap.
 * Instagram URLs: anonymous caption auto-fetch through the same safeFetch (INSTAGRAM_AUTOFETCH='0' disables it, read per request);
 * the caption is imported as text. No caption, any fetch/ImportError, or auto-fetch off -> 422 needs_text.
 * Rate limit: 30 imports per owner per clock hour via an atomic DynamoDB counter
 * (pk=OWNER#{id}, sk=RATE#import#{epoch hour}, ttl 2h), incremented BEFORE any fetch so failures still count.
 */
import { ownerPk, rateSk, llmDaySk, GLOBAL_PK, getDb } from '../db.js';
import { extractFromText, htmlToText } from '../import/extract-text.js';
import { extractImageCandidates } from '../import/extract-images.js';
import { canonicalInstagramUrl, extractInstagramCaption, isInstagramUrl } from '../import/extract-instagram.js';
import { extractStructured } from '../import/extract-structured.js';
import { ImportError } from '../import/import-error.js';
import { getLlmParser } from '../import/llm-parse.js';
import type { RecipeDraft } from '@nabbit/recipe-core';
import { safeFetch as realSafeFetch, safeFetchImage, type FetchedImage } from '../import/safe-fetch.js';
import { putRecipeImage } from '../image-store.js';
import { HttpError, route, type RequestCtx } from '../router.js';

export const IMPORT_LIMIT_PER_HOUR = 30;
export const LLM_LIMIT_PER_DAY = 30;
export const LLM_GLOBAL_LIMIT_PER_DAY_DEFAULT = 300;
export const MAX_IMPORT_TEXT = 50_000;
const HOUR_MS = 3_600_000;

export interface ImportDeps {
  safeFetch: (url: string) => Promise<{ url: string; html: string }>;
  fetchImage: (url: string) => Promise<FetchedImage>;
  now: () => number;
}
const defaults: ImportDeps = { safeFetch: (u) => realSafeFetch(u), fetchImage: (u) => safeFetchImage(u), now: () => Date.now() };
let deps: ImportDeps = defaults;

/** Test hook: inject the fetcher / clock (pass undefined to reset). */
export function setImportDeps(d: Partial<ImportDeps> | undefined): void {
  deps = { ...defaults, ...d };
}

/** App-wide daily LLM cap: LLM_GLOBAL_DAILY_LIMIT when it is a non-negative integer, else the default. 0 = never call the LLM. */
export function llmGlobalLimit(): number {
  const raw = process.env.LLM_GLOBAL_DAILY_LIMIT?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) : LLM_GLOBAL_LIMIT_PER_DAY_DEFAULT;
}

/**
 * Low-confidence heuristic drafts get one LLM attempt, within the per-owner daily cap and then the app-wide daily cap.
 * Any failure keeps the heuristic draft.
 */
async function maybeLlm(ownerId: string, text: string, heuristic: RecipeDraft, sourceUrl?: string): Promise<RecipeDraft> {
  const h = heuristic.recipe;
  if (h.ingredients.length >= 2 && h.steps.length >= 2) return heuristic;
  try {
    const parser = getLlmParser();
    if (!parser) return heuristic;
    const nowMs = deps.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const count = await getDb().incrementCounter(ownerPk(ownerId), llmDaySk(day), Math.floor(nowMs / 1000) + 2 * 86400);
    if (count > LLM_LIMIT_PER_DAY) return heuristic;
    const globalCount = await getDb().incrementCounter(GLOBAL_PK, llmDaySk(day), Math.floor(nowMs / 1000) + 2 * 86400);
    if (globalCount > llmGlobalLimit()) {
      console.warn(`import: app-wide daily LLM cap reached (${globalCount})`);
      return heuristic;
    }
    const recipe = await parser.parse(text, sourceUrl ? { sourceUrl } : {});
    if (!recipe) return heuristic;
    if (recipe.ingredients.length < h.ingredients.length || recipe.steps.length < h.steps.length) return heuristic;
    return { recipe, confidence: 'ai' };
  } catch {
    return heuristic;
  }
}

/** After redirects the page must still be on an Instagram host and not on a login/challenge/privacy interstitial. */
function isInstagramFinalPage(finalUrl: string): boolean {
  if (!isInstagramUrl(finalUrl)) return false;
  try {
    return !/^\/(?:accounts\/login|challenge|privacy\/checks)(?:\/|$)/i.test(new URL(finalUrl).pathname);
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Increment the shared per-hour counter; returns a 429 result when over the limit. */
async function countImport(ownerId: string) {
  const nowMs = deps.now();
  const hour = Math.floor(nowMs / HOUR_MS);
  const count = await getDb().incrementCounter(ownerPk(ownerId), rateSk('import', hour), Math.floor(nowMs / 1000) + 2 * 3600);
  if (count > IMPORT_LIMIT_PER_HOUR) {
    const retryAfter = Math.max(1, Math.ceil(((hour + 1) * HOUR_MS - nowMs) / 1000));
    return { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': String(retryAfter) } };
  }
  return undefined;
}

async function importRecipe({ ownerId, body }: RequestCtx) {
  if (!isObj(body)) throw new HttpError(400, 'body must be a JSON object');
  const hasUrl = body.url !== undefined;
  const hasText = body.text !== undefined;
  if (hasUrl === hasText) throw new HttpError(400, 'provide exactly one of url or text');
  if (hasUrl && (typeof body.url !== 'string' || body.url.trim() === '')) throw new HttpError(400, 'url must be a non-empty string');
  if (hasText && (typeof body.text !== 'string' || body.text.trim() === '' || body.text.length > MAX_IMPORT_TEXT)) {
    throw new HttpError(400, `text must be 1-${MAX_IMPORT_TEXT} characters`);
  }

  const limited = await countImport(ownerId);
  if (limited) return limited;

  if (hasText) {
    const text = body.text as string;
    return { status: 200, body: { draft: await maybeLlm(ownerId, text, extractFromText(text)) } };
  }
  const rawUrl = (body.url as string).trim();
  if (isInstagramUrl(rawUrl)) {
    const url = canonicalInstagramUrl(rawUrl);
    const needsText = { status: 422, body: { error: 'needs_text' } };
    if (process.env.INSTAGRAM_AUTOFETCH === '0') return needsText;
    let caption: string | undefined;
    let images = {};
    try {
      const page = await deps.safeFetch(url);
      if (!isInstagramFinalPage(page.url)) return needsText;
      caption = extractInstagramCaption(page.html);
      if (caption) {
        const candidates = extractImageCandidates(page.html, page.url);
        if (candidates.length) images = { imageUrl: candidates[0], candidates };
      }
    } catch {
      return needsText;
    }
    if (!caption) return needsText;
    return { status: 200, body: { draft: await maybeLlm(ownerId, caption, extractFromText(caption, { sourceUrl: url }), url), ...images } };
  }
  const url = rawUrl;

  try {
    const page = await deps.safeFetch(url);
    const structured = extractStructured(page.html, page.url);
    const candidates = extractImageCandidates(page.html, page.url, structured?.imageUrl);
    const images = candidates.length ? { imageUrl: candidates[0], candidates } : {};
    if (structured) {
      const draft = { ...structured };
      delete draft.imageUrl;
      return { status: 200, body: { draft, ...images } };
    }
    const text = htmlToText(page.html);
    const heuristic = extractFromText(text, { sourceUrl: page.url });
    return { status: 200, body: { draft: await maybeLlm(ownerId, text, heuristic, page.url), ...images } };
  } catch (err) {
    if (err instanceof ImportError) return { status: 422, body: { error: err.code } };
    throw err;
  }
}

async function importImage({ ownerId, body }: RequestCtx) {
  const url = isObj(body) && typeof body.url === 'string' ? body.url.trim() : '';
  if (!/^https:\/\/\S+$/i.test(url)) throw new HttpError(400, 'url must be an https URL');
  const limited = await countImport(ownerId);
  if (limited) return limited;
  try {
    const img = await deps.fetchImage(url);
    const imageKey = await putRecipeImage(ownerId, img.contentType, img.bytes);
    return { status: 200, body: { imageKey } };
  } catch (err) {
    if (err instanceof ImportError) return { status: 422, body: { error: err.code } };
    throw err;
  }
}

/** Register the import route (also runs once on import; tests call it again after `resetRoutes`). */
export function registerImportRoutes(): void {
  route('POST', '/recipes/import', importRecipe);
  route('POST', '/recipes/images/import', importImage);
}

registerImportRoutes();

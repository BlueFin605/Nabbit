/**
 * Recipe import (owner from the JWT; NOTHING is saved, the client previews the draft then POSTs /recipes):
 *   POST /recipes/import  body `{ url }` XOR `{ text }` (text <= 50,000 chars)
 *     200 { draft: RecipeDraft, imageUrl? }
 *     400 { error } invalid body        422 { error: <ImportError code> }
 *     429 { error: 'rate_limited' } + retry-after (seconds)
 * Rate limit: 30 imports per owner per clock hour via an atomic DynamoDB counter
 * (pk=OWNER#{id}, sk=RATE#import#{epoch hour}, ttl 2h), incremented BEFORE any fetch so failures still count.
 */
import { ownerPk, rateSk, getDb } from '../db.js';
import { extractFromText, htmlToText } from '../import/extract-text.js';
import { extractStructured } from '../import/extract-structured.js';
import { ImportError } from '../import/import-error.js';
import { safeFetch as realSafeFetch } from '../import/safe-fetch.js';
import { HttpError, route, type RequestCtx } from '../router.js';

export const IMPORT_LIMIT_PER_HOUR = 30;
export const MAX_IMPORT_TEXT = 50_000;
const HOUR_MS = 3_600_000;

export interface ImportDeps {
  safeFetch: (url: string) => Promise<{ url: string; html: string }>;
  now: () => number;
}
const defaults: ImportDeps = { safeFetch: (u) => realSafeFetch(u), now: () => Date.now() };
let deps: ImportDeps = defaults;

/** Test hook: inject the fetcher / clock (pass undefined to reset). */
export function setImportDeps(d: Partial<ImportDeps> | undefined): void {
  deps = { ...defaults, ...d };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function importRecipe({ ownerId, body }: RequestCtx) {
  if (!isObj(body)) throw new HttpError(400, 'body must be a JSON object');
  const hasUrl = body.url !== undefined;
  const hasText = body.text !== undefined;
  if (hasUrl === hasText) throw new HttpError(400, 'provide exactly one of url or text');
  if (hasUrl && (typeof body.url !== 'string' || body.url.trim() === '')) throw new HttpError(400, 'url must be a non-empty string');
  if (hasText && (typeof body.text !== 'string' || body.text.trim() === '' || body.text.length > MAX_IMPORT_TEXT)) {
    throw new HttpError(400, `text must be 1-${MAX_IMPORT_TEXT} characters`);
  }

  const nowMs = deps.now();
  const hour = Math.floor(nowMs / HOUR_MS);
  const count = await getDb().incrementCounter(ownerPk(ownerId), rateSk('import', hour), Math.floor(nowMs / 1000) + 2 * 3600);
  if (count > IMPORT_LIMIT_PER_HOUR) {
    const retryAfter = Math.max(1, Math.ceil(((hour + 1) * HOUR_MS - nowMs) / 1000));
    return { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': String(retryAfter) } };
  }

  if (hasText) return { status: 200, body: { draft: extractFromText(body.text as string) } };

  try {
    const page = await deps.safeFetch((body.url as string).trim());
    const structured = extractStructured(page.html, page.url);
    if (structured) {
      const { imageUrl, ...draft } = structured;
      return { status: 200, body: { draft, ...(imageUrl ? { imageUrl } : {}) } };
    }
    return { status: 200, body: { draft: extractFromText(htmlToText(page.html), { sourceUrl: page.url }) } };
  } catch (err) {
    if (err instanceof ImportError) return { status: 422, body: { error: err.code } };
    throw err;
  }
}

/** Register the import route (also runs once on import; tests call it again after `resetRoutes`). */
export function registerImportRoutes(): void {
  route('POST', '/recipes/import', importRecipe);
}

registerImportRoutes();

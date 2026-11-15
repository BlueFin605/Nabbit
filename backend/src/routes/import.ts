/**
 * Recipe import (owner from the JWT; NOTHING is saved, the client previews the draft then POSTs /recipes):
 *   POST /recipes/import  body `{ url }` XOR `{ text }` (text <= 50,000 chars), optional boolean `forceRecipe`
 *     422 { error: 'not_a_recipe', reason } when the LLM says the text is no recipe (not for Instagram captions; forceRecipe: true makes the one LLM
 *         call a forced best-effort one; if that still yields nothing usable the heuristic draft is returned)
 *     200 { draft: RecipeDraft, imageUrl?, candidates?: string[], source?: 'linked-page' | 'transcript', videoUrl? }
 *         (images: url imports only, imageUrl === candidates[0]; source/videoUrl: YouTube only, both sources)
 *     400 { error } invalid body        422 { error: <ImportError code> }
 *     429 { error: 'rate_limited' } + retry-after (seconds)
 *   POST /recipes/images/import  body `{ url }` (https) -> 200 { imageKey }: downloads the image through the SSRF guard
 *     and stores it at {ownerId}/{uuid}.{ext}; 400 bad url, 422 { error: <ImportError code> } (incl. not_image), 429 as above.
 *     Shares the import rate limit (same counter). Registered on the import Lambda only.
 * LLM fallback: low-confidence text drafts try the LLM parser, max 30/owner/UTC day (RATE#llm#{date}, ttl 2d),
 * plus an app-wide cap per UTC day (pk=GLOBAL, same sk; LLM_GLOBAL_DAILY_LIMIT, default 300, read per request)
 * so many accounts cannot multiply the spend. The global counter is only bumped once the owner is under their cap.
 * JS-rendered shells (Gatsby page-data.json, Next.js __NEXT_DATA__; only when the page has almost no text and nothing parsed): the embedded app data
 * is reduced to text for the LLM (same caps/validation), or used directly when it holds a schema.org Recipe; nothing usable -> needs_text.
 * Instagram URLs: anonymous caption auto-fetch through the same safeFetch (INSTAGRAM_AUTOFETCH='0' disables it, read per request);
 * the caption is imported as text. No caption, any fetch/ImportError, or auto-fetch off -> 422 needs_text. A NotRecipe
 * verdict on a caption is never a 422: the heuristic draft (and photo) is returned for the client's comment appender.
 * YouTube URLs (optional boolean `ignoreLinkedRecipe`; YOUTUBE_AUTOFETCH='0' disables, read per request): watch page ->
 *   linked recipe page from the description (schema.org only, no LLM; 200 with source 'linked-page' + videoUrl) unless
 *   ignoreLinkedRecipe -> caption transcript + LLM, always, flat steps (200 with source 'transcript', confidence 'ai').
 *   NotRecipe -> 422 not_a_recipe; forceRecipe makes the one LLM call a best-effort one (no isRecipe exit) and nothing
 *   usable -> needs_text; any other miss -> 422 needs_text. See YOUTUBE_* budget below.
 * Rate limit: 30 imports per owner per clock hour via an atomic DynamoDB counter
 * (pk=OWNER#{id}, sk=RATE#import#{epoch hour}, ttl 2h), incremented BEFORE any fetch so failures still count.
 */
import { ownerPk, rateSk, llmDaySk, GLOBAL_PK, getDb } from '../db.js';
import { extractFromText, htmlToText } from '../import/extract-text.js';
import { extractImageCandidates } from '../import/extract-images.js';
import { canonicalInstagramUrl, extractInstagramCaption, isInstagramUrl } from '../import/extract-instagram.js';
import { extractStructuredPage, withoutImageUrl } from '../import/structured-page.js';
import { extractAppData, MAX_APP_DATA_BYTES } from '../import/extract-app-data.js';
import { ImportError } from '../import/import-error.js';
import { flattenLeafStrings, getLlmParser, isNotRecipe, type NotRecipe, type ParsedRecipe } from '../import/llm-parse.js';
import { canonicalYoutubeUrl, captionsToText, extractPlayerData, isYoutubeUrl, pickCaptionTrack } from '../import/extract-youtube.js';
import { candidateRecipeLinks, tryLinkedRecipe } from '../import/youtube-links.js';
import { fetchVideoSnippet as realFetchVideoSnippet, type YoutubeSnippet } from '../import/youtube-api.js';
import { countSteps, type RecipeDraft } from '@nabbit/recipe-core';
import { safeFetch as realSafeFetch, safeFetchCaptions, safeFetchImage, safeFetchJson, type FetchedImage } from '../import/safe-fetch.js';
import { putRecipeImage } from '../image-store.js';
import { HttpError, route, type RequestCtx } from '../router.js';

export const IMPORT_LIMIT_PER_HOUR = 30;
export const LLM_LIMIT_PER_DAY = 30;
export const LLM_GLOBAL_LIMIT_PER_DAY_DEFAULT = 300;
export const MAX_IMPORT_TEXT = 50_000;
/** A fetched page with no structured data, fewer visible characters than this and no parsed ingredients or steps is a JS shell. */
export const MIN_PAGE_TEXT_CHARS = 200;
const HOUR_MS = 3_600_000;

/*
 * YouTube time budget. API Gateway cuts the request at 29 s and the import Lambda timeout is also 29 s. Worst case,
 * measured from the start of the request handler:
 *   watch page (safe-fetch cap 5 s)                                         -> t <= 5 s
 *   linked recipe pages, abandoned at YOUTUBE_LINKS_DEADLINE_MS             -> t <= 5 s
 *   caption track, cut off at YOUTUBE_LLM_START_DEADLINE_MS; the LLM is not
 *   started after it either (needs_text instead)                            -> t <= 8 s
 *   2 DynamoDB counter writes (~<1 s) + LLM (Bedrock parser timeout 15 s)   -> t <= ~24 s
 * That leaves ~5 s of the 29 s for cold start (not measured) and response overhead.
 * A slow watch page (> 5 s used) means no linked lookup; a very slow one leaves no time for captions -> needs_text.
 */
/** Linked-recipe lookups stop once this much of the request has elapsed; an in-flight page fetch is abandoned. */
export const YOUTUBE_LINKS_DEADLINE_MS = 5_000;
/** Caption fetch cut-off, and the transcript LLM call (up to 15 s) is not started after this point; needs_text instead. */
export const YOUTUBE_LLM_START_DEADLINE_MS = 8_000;
/** Fewer characters than this across description + transcript is not worth an LLM call. */
export const MIN_YOUTUBE_TEXT_CHARS = 200;
export const MAX_YOUTUBE_DESCRIPTION_CHARS = 6_000;
/** Whole LLM input cap for the YouTube path (the parser slices its input at the same length). */
export const MAX_YOUTUBE_LLM_INPUT_CHARS = 20_000;

/** 200 body of POST /recipes/import (mirrored by the frontend's ImportResult). */
export interface ImportResponseBody {
  draft: RecipeDraft;
  imageUrl?: string;
  candidates?: string[];
  /** YouTube only: which attempt produced the draft. */
  source?: 'linked-page' | 'transcript';
  /** YouTube only, both sources: the canonical video URL (on linked-page, draft.recipe.sourceUrl is the recipe page). */
  videoUrl?: string;
}

export interface ImportDeps {
  safeFetch: (url: string) => Promise<{ url: string; html: string }>;
  /** A YouTube caption track (XML/json3); SSRF-guarded, redirects pinned to the track's origin. */
  fetchCaptions: (url: string) => Promise<{ url: string; text: string }>;
  fetchImage: (url: string) => Promise<FetchedImage>;
  /** YouTube Data API title + description by video id (undefined = off or failed; never throws). */
  fetchVideoSnippet: (videoId: string) => Promise<YoutubeSnippet | undefined>;
  /** Same-origin embedded-app-data fetch (Gatsby page-data.json); SSRF-guarded and size-capped like safeFetch. */
  fetchJson: (url: string) => Promise<{ url: string; text: string }>;
  now: () => number;
  /** Hourly import cap; only the local e2e stack raises it (local.ts). */
  importLimit: number;
}
const defaults: ImportDeps = {
  safeFetch: (u) => realSafeFetch(u),
  fetchCaptions: (u) => safeFetchCaptions(u),
  fetchImage: (u) => safeFetchImage(u),
  fetchVideoSnippet: async (id) => {
    const r = await realFetchVideoSnippet(id);
    if (!r.snippet && r.reason !== 'off') ytLog({ stage: 'api_snippet', vid: id, ok: false, reason: r.reason }, true);
    return r.snippet;
  },
  fetchJson: (u) => safeFetchJson(u, {}, MAX_APP_DATA_BYTES, { allowedOrigin: new URL(u).origin }),
  now: () => Date.now(),
  importLimit: IMPORT_LIMIT_PER_HOUR,
};
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
 * One LLM attempt within the per-owner daily cap and then the app-wide daily cap (both bumped before the call).
 * No parser, a cap reached, or any error -> undefined.
 */
async function callLlm(
  ownerId: string,
  text: string,
  ctx: { sourceUrl?: string; flatSteps?: boolean; forceRecipe?: boolean },
): Promise<ParsedRecipe | NotRecipe | undefined> {
  try {
    const parser = getLlmParser();
    if (!parser) return undefined;
    const nowMs = deps.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const count = await getDb().incrementCounter(ownerPk(ownerId), llmDaySk(day), Math.floor(nowMs / 1000) + 2 * 86400);
    if (count > LLM_LIMIT_PER_DAY) return undefined;
    const globalCount = await getDb().incrementCounter(GLOBAL_PK, llmDaySk(day), Math.floor(nowMs / 1000) + 2 * 86400);
    if (globalCount > llmGlobalLimit()) {
      console.warn(`import: app-wide daily LLM cap reached (${globalCount})`);
      return undefined;
    }
    return await parser.parse(text, ctx);
  } catch {
    return undefined;
  }
}

/**
 * Low-confidence heuristic drafts get one LLM attempt (callLlm). Any failure keeps the heuristic draft. A NotRecipe
 * verdict throws ImportError('not_a_recipe', .., reason) (-> 422). With forceRecipe ("Import anyway") the one call is a
 * forced best-effort one (no isRecipe exit); a refusal anyway keeps the heuristic draft. `keepOnNotRecipe` (Instagram
 * captions) also keeps the heuristic draft on a NotRecipe verdict: "recipe in the comments" posts are recovered by the
 * client's comment appender, which needs the draft and the post photo.
 */
async function maybeLlm(
  ownerId: string,
  text: string,
  heuristic: RecipeDraft,
  sourceUrl?: string,
  forceRecipe = false,
  keepOnNotRecipe = false,
): Promise<RecipeDraft> {
  const h = heuristic.recipe;
  if (h.ingredients.length >= 2 && countSteps(h.steps) >= 2) return heuristic;
  const recipe = await callLlm(ownerId, text, { ...(sourceUrl ? { sourceUrl } : {}), ...(forceRecipe ? { forceRecipe: true } : {}) });
  if (!recipe) return heuristic;
  if (isNotRecipe(recipe)) {
    if (forceRecipe || keepOnNotRecipe) return heuristic;
    throw new ImportError('not_a_recipe', recipe.reason, recipe.reason);
  }
  if (recipe.ingredients.length < h.ingredients.length || countSteps(recipe.steps) < countSteps(h.steps)) return heuristic;
  return { recipe, confidence: 'ai' };
}

const NEEDS_TEXT = () => ({ status: 422, body: { error: 'needs_text' } });

/** `p()` raced against an absolute deadline (deps.now() clock); rejects at once, without starting `p`, when it has passed. */
function beforeDeadline<T>(p: () => Promise<T>, deadlineMs: number): Promise<T> {
  const remaining = deadlineMs - deps.now();
  if (remaining <= 0) return Promise.reject(new ImportError('timeout', 'Import time budget used up'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ImportError('timeout', 'Import time budget used up')), remaining);
  });
  const work = p();
  work.catch(() => undefined); // an abandoned fetch may still fail later
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The first `max` chars of `s`, cut back to the last sentence end (else the last space) when one is in the second half. */
function truncateAtSentence(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return '';
  const cut = s.slice(0, max + 1); // +1 so a sentence ending exactly at max is seen as followed by a space
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentence >= max / 2) return s.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return s.slice(0, space >= max / 2 ? space : max).trimEnd();
}

/** Title, blank line, description (capped), blank line, transcript cut so the whole input fits MAX_YOUTUBE_LLM_INPUT_CHARS. */
function youtubeLlmInput(title: string, description: string, transcript: string): string {
  const head = `${title.trim()}\n\n${description.trim().slice(0, MAX_YOUTUBE_DESCRIPTION_CHARS)}\n\n`;
  return head + truncateAtSentence(transcript, MAX_YOUTUBE_LLM_INPUT_CHARS - head.length);
}

/** One structured JSON line per YouTube stage. Never pass the description, the API key or full URLs. */
function ytLog(fields: Record<string, unknown>, warn = false): void {
  const line = JSON.stringify({ evt: 'yt', ...fields });
  if (warn) console.warn(line);
  else console.log(line);
}

/**
 * YouTube: watch page (or, when walled/empty, the Data API snippet) -> linked recipe page (unless ignoreLinkedRecipe)
 * -> caption transcript + LLM -> needs_text. `startMs` is when the request began; the deadlines above are relative to it.
 */
async function importYoutube(ownerId: string, rawUrl: string, startMs: number, opts: { forceRecipe: boolean; ignoreLinkedRecipe: boolean }) {
  const videoUrl = canonicalYoutubeUrl(rawUrl);
  const vid = videoUrl ? (new URL(videoUrl).searchParams.get('v') ?? undefined) : undefined;
  const needsText = (reason: string) => {
    ytLog({ stage: 'result', vid, kind: 'needs_text', reason });
    return NEEDS_TEXT();
  };
  if (process.env.YOUTUBE_AUTOFETCH === '0') return needsText('autofetch_off');
  if (!videoUrl || !vid) return needsText('bad_url');

  let player: ReturnType<typeof extractPlayerData>;
  try {
    const page = await deps.safeFetch(videoUrl);
    // A redirect off the YouTube hosts (consent.youtube.com, accounts.google.com) is a wall.
    if (!isYoutubeUrl(page.url)) {
      ytLog({ stage: 'watch_page', vid, ok: false, reason: 'wall_redirect' });
    } else {
      ytLog({ stage: 'watch_page', vid, ok: true });
      player = extractPlayerData(page.html);
    }
  } catch (err) {
    ytLog({ stage: 'watch_page', vid, ok: false, reason: err instanceof ImportError ? err.code : 'error' }, true);
  }
  ytLog({ stage: 'player_data', vid, present: !!player, descLen: player?.description.length ?? 0, trackCount: player?.captionTracks.length ?? 0 });

  let title = player?.title ?? '';
  let description = player?.description ?? '';
  if (!description.trim()) {
    // Walled, no player data, or an empty description: the Data API (when configured) can still supply title + description.
    const apiDeadline = startMs + YOUTUBE_LLM_START_DEADLINE_MS;
    const snippet = await beforeDeadline(() => deps.fetchVideoSnippet(vid), apiDeadline).catch(() => undefined);
    if (snippet) {
      ytLog({ stage: 'api_snippet', vid, ok: true, descLen: snippet.description.length });
      title = title || snippet.title;
      description = snippet.description;
    }
  }
  if (!player && !description.trim()) return needsText('no_page_no_api');

  const captionTracks = player?.captionTracks ?? [];
  if (!opts.ignoreLinkedRecipe) {
    const linksDeadline = startMs + YOUTUBE_LINKS_DEADLINE_MS;
    const links = candidateRecipeLinks(description);
    const linked = await tryLinkedRecipe(links, {
      safeFetch: (u) => beforeDeadline(() => deps.safeFetch(u), linksDeadline),
    });
    ytLog({ stage: 'linked', vid, tried: links.length, hit: !!linked });
    if (linked) {
      const { recipe, imageUrl, candidates } = linked;
      // RecipeDraft has no notes field, so the video link travels as videoUrl only.
      const body: ImportResponseBody = { draft: recipe, source: 'linked-page', videoUrl, ...(imageUrl ? { imageUrl } : {}), ...(candidates ? { candidates } : {}) };
      ytLog({ stage: 'result', vid, kind: 'linked-page' });
      return { status: 200, body };
    }
  }

  const track = pickCaptionTrack(captionTracks);
  if (!track || !isYoutubeUrl(track.baseUrl)) return needsText('no_caption_track');
  const llmDeadline = startMs + YOUTUBE_LLM_START_DEADLINE_MS;
  let transcript: string;
  try {
    const captions = await beforeDeadline(() => deps.fetchCaptions(track.baseUrl), llmDeadline);
    if (!isYoutubeUrl(captions.url)) {
      ytLog({ stage: 'captions', vid, ok: false, reason: 'redirect_off_youtube' });
      return needsText('captions_unavailable');
    }
    transcript = captionsToText(captions.text);
    ytLog({ stage: 'captions', vid, ok: transcript.length > 0, status: 'fetched', textLen: transcript.length });
  } catch (err) {
    ytLog({ stage: 'captions', vid, ok: false, reason: err instanceof ImportError ? err.code : 'error' }, true);
    return needsText('captions_unavailable');
  }
  // YouTube answers anonymous caption requests with an empty 200 body: that is "no captions", not a short transcript.
  if (!transcript) return needsText('empty_captions');
  if ((description.trim() + transcript).length < MIN_YOUTUBE_TEXT_CHARS) return needsText('too_short');
  if (!getLlmParser()) return needsText('no_llm');
  if (deps.now() >= llmDeadline) return needsText('deadline');

  // Spoken prose has no heuristic parse, so the transcript path always asks the LLM (same caps as every other call).
  // With forceRecipe ("Import anyway" after not_a_recipe) there is no heuristic draft to keep, so the single LLM call
  // is a forced best-effort one (no isRecipe exit); nothing usable -> needs_text.
  const ctx = { sourceUrl: videoUrl, flatSteps: true, ...(opts.forceRecipe ? { forceRecipe: true } : {}) };
  const recipe = await callLlm(ownerId, youtubeLlmInput(title, description, transcript), ctx);
  if (!recipe) return needsText('llm_unavailable');
  if (isNotRecipe(recipe)) {
    if (opts.forceRecipe) return needsText('llm_not_recipe_forced');
    ytLog({ stage: 'result', vid, kind: 'not_a_recipe' });
    throw new ImportError('not_a_recipe', recipe.reason, recipe.reason);
  }
  const draft: RecipeDraft = { recipe: { ...recipe, steps: flattenLeafStrings(recipe.steps), sourceUrl: videoUrl }, confidence: 'ai' };
  const body: ImportResponseBody = { draft, source: 'transcript', videoUrl };
  ytLog({ stage: 'result', vid, kind: 'transcript' });
  return { status: 200, body };
}

const importErrorResult = (err: ImportError) => ({ status: 422, body: err.reason !== undefined ? { error: err.code, reason: err.reason } : { error: err.code } });

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
  if (count > deps.importLimit) {
    const retryAfter = Math.max(1, Math.ceil(((hour + 1) * HOUR_MS - nowMs) / 1000));
    return { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': String(retryAfter) } };
  }
  return undefined;
}

async function importRecipe(ctx: RequestCtx) {
  try {
    return await importRecipeInner(ctx);
  } catch (err) {
    if (err instanceof ImportError) return importErrorResult(err);
    throw err;
  }
}

async function importRecipeInner({ ownerId, body }: RequestCtx) {
  const startMs = deps.now();
  if (!isObj(body)) throw new HttpError(400, 'body must be a JSON object');
  const hasUrl = body.url !== undefined;
  const hasText = body.text !== undefined;
  if (hasUrl === hasText) throw new HttpError(400, 'provide exactly one of url or text');
  if (hasUrl && (typeof body.url !== 'string' || body.url.trim() === '')) throw new HttpError(400, 'url must be a non-empty string');
  if (hasText && (typeof body.text !== 'string' || body.text.trim() === '' || body.text.length > MAX_IMPORT_TEXT)) {
    throw new HttpError(400, `text must be 1-${MAX_IMPORT_TEXT} characters`);
  }

  if (body.forceRecipe !== undefined && typeof body.forceRecipe !== 'boolean') throw new HttpError(400, 'forceRecipe must be a boolean');
  const forceRecipe = body.forceRecipe === true;
  if (body.ignoreLinkedRecipe !== undefined && typeof body.ignoreLinkedRecipe !== 'boolean') throw new HttpError(400, 'ignoreLinkedRecipe must be a boolean');
  const ignoreLinkedRecipe = body.ignoreLinkedRecipe === true;

  const limited = await countImport(ownerId);
  if (limited) return limited;

  if (hasText) {
    const text = body.text as string;
    return { status: 200, body: { draft: await maybeLlm(ownerId, text, extractFromText(text), undefined, forceRecipe) } };
  }
  const rawUrl = (body.url as string).trim();
  if (isYoutubeUrl(rawUrl)) return importYoutube(ownerId, rawUrl, startMs, { forceRecipe, ignoreLinkedRecipe });
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
    // A caption that is not a recipe ("recipe in the comments") keeps the heuristic draft + photo: the comment appender recovers it.
    const draft = await maybeLlm(ownerId, caption, extractFromText(caption, { sourceUrl: url }), url, forceRecipe, true);
    return { status: 200, body: { draft, ...images } };
  }
  const url = rawUrl;

  try {
    const page = await deps.safeFetch(url);
    const { sourceUrl, structured, images } = extractStructuredPage(page);
    if (structured) return { status: 200, body: { draft: withoutImageUrl(structured), ...images } };
    const text = htmlToText(page.html);
    const heuristic = extractFromText(text, { sourceUrl });
    // Client-rendered shell (e.g. Gatsby, CSR Next): essentially no text and nothing parsed. Try the page's embedded app data
    // (the only LLM attempt this request makes); if that yields nothing, ask the user to paste. Pages with real text never use it.
    if (text.trim().length < MIN_PAGE_TEXT_CHARS && heuristic.recipe.ingredients.length === 0 && countSteps(heuristic.recipe.steps) === 0) {
      const app = await extractAppData(page.html, page.url, deps.fetchJson, sourceUrl).catch(() => undefined);
      if (app?.structured) {
        const draft = { ...app.structured };
        const appImages = extractImageCandidates(page.html, page.url, draft.imageUrl);
        delete draft.imageUrl;
        return { status: 200, body: { draft, ...(appImages.length ? { imageUrl: appImages[0], candidates: appImages } : {}) } };
      }
      if (app?.text) {
        const ai = await maybeLlm(ownerId, app.text, extractFromText('', { sourceUrl }), sourceUrl, forceRecipe);
        if (ai.confidence === 'ai') return { status: 200, body: { draft: ai, ...images } };
      }
      return { status: 422, body: { error: 'needs_text' } };
    }
    return { status: 200, body: { draft: await maybeLlm(ownerId, text, heuristic, sourceUrl, forceRecipe), ...images } };
  } catch (err) {
    if (err instanceof ImportError) return importErrorResult(err);
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

// Embedded app data for client-rendered recipe sites. A Gatsby shell has no recipe in its HTML but publishes the page's
// data at /page-data/<path>/page-data.json (same origin); a Next.js page embeds it in <script id="__NEXT_DATA__">.
// The JSON is untrusted: it is only walked for strings, never executed, and the result is bounded text for the LLM
// (or, when the JSON holds a schema.org Recipe, a structured draft). The fetch is injected so the caller supplies the SSRF-guarded one.
import { extractStructured, type StructuredDraft } from './extract-structured.js';

/** Largest page-data.json accepted (enforced again by the fetcher). */
export const MAX_APP_DATA_BYTES = 1024 * 1024;
/** Cap on the reduced text handed to the LLM. */
export const MAX_APP_DATA_CHARS = 20_000;

export type AppDataSource = { kind: 'gatsby'; dataUrl: string } | { kind: 'next'; json: unknown };
export type FetchJson = (url: string) => Promise<{ url: string; text: string }>;
export interface AppData {
  structured?: StructuredDraft;
  text?: string;
}

/** `<origin>/page-data<pathname with trailing slash>page-data.json`; the root page is `index`. */
export function gatsbyDataUrl(pageUrl: string): string {
  const u = new URL(pageUrl);
  let p = u.pathname;
  if (!p.endsWith('/')) p += '/';
  if (p === '/') p = '/index/';
  return `${u.origin}/page-data${p}page-data.json`;
}

const GATSBY_CHUNKS = /___chunkMapping|gatsby-chunk-mapping/;
const MAX_TAG_CHARS = 2000;
const MAX_NEXT_DATA_CANDIDATES = 5;

/**
 * Content of the first <script ... id="__NEXT_DATA__" ...>...</script>, found with indexOf scans only
 * (a backtracking regex is quadratic on hostile HTML). `lower` is html.toLowerCase().
 */
function nextDataText(html: string, lower: string): string | undefined {
  let from = 0;
  for (let n = 0; n < MAX_NEXT_DATA_CANDIDATES; n++) {
    let at = -1;
    const dq = lower.indexOf('id="__next_data__"', from);
    const sq = lower.indexOf("id='__next_data__'", from);
    if (dq !== -1 && (sq === -1 || dq < sq)) at = dq;
    else if (sq !== -1) at = sq;
    if (at === -1) return undefined;
    from = at + 1;
    // the opening "<script" must be just before, within one tag's worth of characters, with no '>' between
    const lt = lower.lastIndexOf('<', at);
    if (lt === -1 || at - lt > MAX_TAG_CHARS || !lower.startsWith('<script', lt) || lower.lastIndexOf('>', at) > lt) continue;
    const gt = lower.indexOf('>', at);
    if (gt === -1) return undefined;
    const end = lower.indexOf('</script', gt + 1);
    if (end === -1) return undefined;
    return html.slice(gt + 1, end);
  }
  return undefined;
}

/** True when some <meta ...> tag is the Gatsby generator tag. Linear: one pass of indexOf, bounded tag length. */
function hasGatsbyMeta(lower: string): boolean {
  let i = lower.indexOf('<meta');
  let gt = -1;
  while (i !== -1) {
    if (gt < i) {
      gt = lower.indexOf('>', i);
      if (gt === -1) return false;
    }
    if (gt - i <= MAX_TAG_CHARS) {
      const tag = lower.slice(i, gt);
      if (/\bname=["']generator["']/.test(tag) && /\bcontent=["']gatsby/.test(tag)) return true;
    }
    i = lower.indexOf('<meta', i + 5);
  }
  return false;
}

export function detectAppData(html: string, pageUrl: string): AppDataSource | undefined {
  const lower = html.toLowerCase();
  const raw = nextDataText(html, lower);
  if (raw && raw.length <= MAX_APP_DATA_BYTES) {
    try {
      return { kind: 'next', json: JSON.parse(raw) };
    } catch {
      /* malformed embedded JSON is just "no app data" */
    }
  }
  if (hasGatsbyMeta(lower) || GATSBY_CHUNKS.test(html)) {
    try {
      return { kind: 'gatsby', dataUrl: gatsbyDataUrl(pageUrl) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const KEEP = /title|name|headline|description|ingredient|method|step|instruction|serv|yield|prep|cook|time|portion/i;
// Noise keys are matched on whole words / camelCase segments (stage, percentage, subheader must not match tag, age, header).
const DROP_STEMS = ['excerpt', 'nutri', 'seo', 'author', 'related', 'image', 'asset', 'url', 'href', 'slug', 'categor', 'health', 'tag', 'badge', 'video', 'advert', 'nav', 'menu', 'footer', 'header', 'cookie', 'timer', 'logo', 'crop', 'hotspot', 'keyword', 'sponsor', 'promo', 'newsletter', 'social', 'share', 'comment', 'rating', 'review'];
const DROP_WORDS = new Set(['ad', 'ads', 'meta']);
const keySegments = (key: string): string[] =>
  key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const isDropKey = (key: string): boolean =>
  key.startsWith('_') || keySegments(key).some((w) => DROP_WORDS.has(w) || DROP_STEMS.some((st) => w.startsWith(st)));
const MAX_DEPTH = 40;

/** Walk the JSON and keep strings under recipe-ish keys (and not under noise keys), as `key: value` lines, capped. */
export function reduceAppData(json: unknown): string {
  const lines: string[] = [];
  let size = 0;
  let last = '';
  const walk = (v: unknown, key: string, keep: boolean, depth: number): void => {
    if (size >= MAX_APP_DATA_CHARS || depth > MAX_DEPTH || v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      if (!keep || !s || s === last) return;
      const line = `${key}: ${s}`.slice(0, MAX_APP_DATA_CHARS - size);
      lines.push(line);
      size += line.length + 1;
      last = s;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key, keep, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (isDropKey(k)) continue;
        walk(x, k, keep || KEEP.test(k), depth + 1);
      }
    }
  };
  walk(json, '', false, 0);
  return lines.join('\n').slice(0, MAX_APP_DATA_CHARS);
}

function isRecipeType(t: unknown): boolean {
  return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
}

/** First object with `@type` Recipe anywhere in the JSON. */
export function findSchemaRecipe(json: unknown): Record<string, unknown> | undefined {
  const stack: [unknown, number][] = [[json, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== 'object' || d > MAX_DEPTH) continue;
    if (!Array.isArray(v) && isRecipeType((v as Record<string, unknown>)['@type'])) return v as Record<string, unknown>;
    const kids = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], d + 1]);
  }
  return undefined;
}

function structuredFrom(recipe: Record<string, unknown>, pageUrl: string): StructuredDraft | undefined {
  const ld = JSON.stringify({ '@context': 'https://schema.org', ...recipe }).replace(/</g, '\\u003c');
  return extractStructured(`<html><head><script type="application/ld+json">${ld}</script></head></html>`, pageUrl);
}

/**
 * Pull recipe data out of the page's embedded app data. Returns undefined when the page has none, the fetch is refused
 * or fails, it is not same-origin, it is oversized or not JSON, or nothing recipe-like is in it.
 */
export async function extractAppData(html: string, pageUrl: string, fetchJson: FetchJson, sourceUrl: string = pageUrl): Promise<AppData | undefined> {
  const src = detectAppData(html, pageUrl);
  if (!src) return undefined;
  let json: unknown;
  if (src.kind === 'next') {
    json = src.json;
  } else {
    try {
      const origin = new URL(pageUrl).origin;
      const res = await fetchJson(src.dataUrl);
      if (new URL(res.url).origin !== origin) return undefined;
      if (res.text.length > MAX_APP_DATA_BYTES) return undefined;
      json = JSON.parse(res.text);
    } catch {
      return undefined;
    }
  }
  const recipe = findSchemaRecipe(json);
  if (recipe) {
    const structured = structuredFrom(recipe, sourceUrl);
    if (structured) return { structured };
  }
  const text = reduceAppData(json);
  return text ? { text } : undefined;
}

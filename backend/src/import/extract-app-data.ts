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

const GATSBY_META = /<meta\b[^>]*\bname=["']generator["'][^>]*\bcontent=["']Gatsby|<meta\b[^>]*\bcontent=["']Gatsby[^>]*\bname=["']generator["']/i;
const GATSBY_CHUNKS = /___chunkMapping|gatsby-chunk-mapping/;
const NEXT_DATA = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

export function detectAppData(html: string, pageUrl: string): AppDataSource | undefined {
  const m = NEXT_DATA.exec(html);
  if (m && m[1] && m[1].length <= MAX_APP_DATA_BYTES) {
    try {
      return { kind: 'next', json: JSON.parse(m[1]) };
    } catch {
      /* malformed embedded JSON is just "no app data" */
    }
  }
  if (GATSBY_META.test(html) || GATSBY_CHUNKS.test(html)) {
    try {
      return { kind: 'gatsby', dataUrl: gatsbyDataUrl(pageUrl) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const KEEP = /title|name|headline|description|ingredient|method|step|instruction|serv|yield|prep|cook|time|portion/i;
const DROP =
  /^_|excerpt|nutri|seo|author|related|image|asset|url|href|slug|categor|health|tag|badge|video|^ad|advert|nav|menu|footer|header|cookie|timer|logo|crop|hotspot|keyword|meta|sponsor|promo|newsletter|social|share|comment|rating|review/i;
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
        if (DROP.test(k)) continue;
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
export async function extractAppData(html: string, pageUrl: string, fetchJson: FetchJson): Promise<AppData | undefined> {
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
    const structured = structuredFrom(recipe, pageUrl);
    if (structured) return { structured };
  }
  const text = reduceAppData(json);
  return text ? { text } : undefined;
}

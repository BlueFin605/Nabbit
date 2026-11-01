import { parse, type HTMLElement } from 'node-html-parser';
import { convertTemperatures, parseIngredient, toMetric } from '@nabbit/recipe-core';
import type { RecipeDraft } from '@nabbit/recipe-core';

export type StructuredDraft = RecipeDraft & { imageUrl?: string };

// Limits keeping work bounded on hostile or pathological pages.
const MAX_HTML = 5_000_000;
const MAX_JSON_BLOCKS = 25;
const MAX_JSON_BLOCK = 1_000_000;
const MAX_NODES = 20_000;
const MAX_DEPTH = 12;
const MAX_TEXT = 2_000;
const MAX_ITEMS = 200;
const MAX_TAGS = 10;
const DEFAULT_SERVINGS = 4;

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (v: Json): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strip tags and decode entities (HTML is parsed, never executed). */
function cleanText(raw: string): string {
  let s = raw.length > MAX_TEXT * 4 ? raw.slice(0, MAX_TEXT * 4) : raw;
  s = parse(`<div>${s}</div>`).text;
  // Doubly-encoded markup (&lt;b&gt;) decodes to tags on the first pass.
  if (/<[a-z/][^>]*>/i.test(s)) s = parse(`<div>${s}</div>`).text;
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/** Text -> clean, non-empty lines; block-level tags count as line breaks. */
function toLines(raw: string): string[] {
  return raw
    .replace(/<br\s*\/?>|<\/(p|li|div|h\d)>/gi, '\n')
    .split(/\r?\n/)
    .map(cleanText)
    .filter(Boolean);
}

function asString(v: Json): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return asString(v.find((x) => typeof x === 'string' || typeof x === 'number'));
  if (isObj(v)) return asString(v['@value'] ?? v['name'] ?? v['text']);
  return undefined;
}

function hasType(node: Obj): boolean {
  const t = node['@type'];
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === 'string' && /(^|[/#:])Recipe$/.test(x));
}

/** Breadth-first search for a Recipe node with a hard node and depth budget. */
function findRecipe(root: Json): Obj | undefined {
  const queue: Array<[Json, number]> = [[root, 0]];
  let seen = 0;
  for (let i = 0; i < queue.length && seen < MAX_NODES; i++) {
    const [v, depth] = queue[i];
    seen++;
    if (Array.isArray(v)) {
      if (depth < MAX_DEPTH) for (const x of v.slice(0, MAX_NODES)) queue.push([x, depth + 1]);
    } else if (isObj(v)) {
      if (hasType(v)) return v;
      if (depth < MAX_DEPTH) for (const k of Object.keys(v)) if (k === '@graph' || k === 'mainEntity' || k === 'mainEntityOfPage' || k === 'itemListElement' || isObj(v[k]) || Array.isArray(v[k])) queue.push([v[k], depth + 1]);
    }
  }
  return undefined;
}

function jsonLdRecipe(root: HTMLElement): Obj | undefined {
  const scripts = root.querySelectorAll('script').filter((s) => /^application\/ld\+json\b/i.test(s.getAttribute('type')?.trim() ?? ''));
  for (const s of scripts.slice(0, MAX_JSON_BLOCKS)) {
    const body = s.rawText.trim();
    if (!body || body.length > MAX_JSON_BLOCK) continue;
    let data: Json;
    try {
      data = JSON.parse(body);
    } catch {
      continue;
    }
    const found = findRecipe(data);
    if (found) return found;
  }
  return undefined;
}

function stepsFrom(v: Json, out: string[], depth = 0): void {
  if (out.length >= MAX_ITEMS || depth > MAX_DEPTH) return;
  if (typeof v === 'string') {
    out.push(...toLines(v));
  } else if (Array.isArray(v)) {
    for (const x of v.slice(0, MAX_ITEMS)) stepsFrom(x, out, depth + 1);
  } else if (isObj(v)) {
    if (v['itemListElement'] !== undefined) stepsFrom(v['itemListElement'], out, depth + 1);
    else if (typeof v['text'] === 'string') out.push(...toLines(v['text']));
    else if (typeof v['name'] === 'string') out.push(...toLines(v['name']));
  }
  if (out.length > MAX_ITEMS) out.length = MAX_ITEMS;
}

function parseServings(v: Json): number {
  const s = asString(v);
  const m = s ? /\d+/.exec(s) : null;
  const n = m ? parseInt(m[0], 10) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : DEFAULT_SERVINGS;
}

function parseTags(...vals: Json[]): string[] {
  const out: string[] = [];
  const add = (x: Json) => {
    if (Array.isArray(x)) return x.slice(0, 100).forEach(add);
    const s = asString(x);
    if (!s) return;
    for (const part of cleanText(s).split(',')) {
      const t = part.trim().toLowerCase();
      if (t && t.length <= 50 && !out.includes(t)) out.push(t);
    }
  };
  vals.forEach(add);
  return out.slice(0, MAX_TAGS);
}

function resolveUrl(v: string | undefined, base: string): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function imageFrom(v: Json, base: string): string | undefined {
  if (typeof v === 'string') return resolveUrl(v, base);
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 20)) {
      const r = imageFrom(x, base);
      if (r) return r;
    }
    return undefined;
  }
  if (isObj(v)) return resolveUrl(asString(v['url'] ?? v['contentUrl']), base);
  return undefined;
}

interface Raw {
  title: string;
  ingredients: string[];
  steps: string[];
  servings: number;
  tags: string[];
  image?: string;
}

function fromJsonLd(node: Obj, base: string): Raw {
  const ing = node['recipeIngredient'] ?? node['ingredients'];
  const ingredients = (Array.isArray(ing) ? ing : ing === undefined ? [] : [ing])
    .slice(0, MAX_ITEMS)
    .map((x) => cleanText(asString(x) ?? ''))
    .filter(Boolean);
  const steps: string[] = [];
  stepsFrom(node['recipeInstructions'], steps);
  return {
    title: cleanText(asString(node['name']) ?? ''),
    ingredients,
    steps,
    servings: parseServings(node['recipeYield']),
    tags: parseTags(node['keywords'], node['recipeCategory']),
    image: imageFrom(node['image'], base),
  };
}

// ---- microdata ----

function nearestScope(el: HTMLElement): HTMLElement | null {
  let p = el.parentNode as HTMLElement | null;
  while (p) {
    if (p.hasAttribute?.('itemscope')) return p;
    p = p.parentNode as HTMLElement | null;
  }
  return null;
}

function propValue(el: HTMLElement): string {
  const tag = el.tagName?.toLowerCase();
  if (tag === 'meta') return el.getAttribute('content') ?? '';
  if (tag === 'img' || tag === 'source') return el.getAttribute('src') ?? '';
  if (tag === 'a' || tag === 'link') return el.getAttribute('href') ?? el.text;
  if (tag === 'time') return el.getAttribute('datetime') ?? el.text;
  return el.text;
}

function microdataRecipe(root: HTMLElement, base: string): Raw | undefined {
  const scope = root
    .querySelectorAll('[itemscope]')
    .slice(0, MAX_NODES)
    .find((e) => /schema\.org\/Recipe\b/i.test(e.getAttribute('itemtype') ?? ''));
  if (!scope) return undefined;
  const props = scope
    .querySelectorAll('[itemprop]')
    .slice(0, MAX_NODES)
    .filter((e) => nearestScope(e) === scope);
  const named = (...names: string[]) =>
    props.filter((e) => names.some((n) => (e.getAttribute('itemprop') ?? '').split(/\s+/).includes(n)));
  const first = (...names: string[]) => named(...names)[0];

  const ingredients = named('recipeIngredient', 'ingredients')
    .slice(0, MAX_ITEMS)
    .map((e) => cleanText(propValue(e)))
    .filter(Boolean);

  const steps: string[] = [];
  for (const el of named('recipeInstructions')) {
    const lis = el.querySelectorAll('li');
    const texts = el.querySelectorAll('[itemprop="text"]');
    if (lis.length) lis.forEach((li) => steps.push(...toLines(li.text)));
    else if (texts.length) texts.forEach((t) => steps.push(...toLines(t.text)));
    else steps.push(...toLines(el.innerHTML));
    if (steps.length >= MAX_ITEMS) break;
  }
  steps.length = Math.min(steps.length, MAX_ITEMS);

  const nameEl = first('name');
  const imgEl = first('image');
  const yieldEl = first('recipeYield');
  return {
    title: nameEl ? cleanText(propValue(nameEl)) : '',
    ingredients,
    steps,
    servings: parseServings(yieldEl ? propValue(yieldEl) : undefined),
    tags: parseTags(...named('keywords', 'recipeCategory').map(propValue)),
    image: imgEl ? resolveUrl(propValue(imgEl), base) : undefined,
  };
}

/**
 * Extract a schema.org Recipe (JSON-LD first, then microdata) from HTML.
 * Pure and synchronous; the HTML is parsed, never executed. Returns undefined
 * when no usable recipe is found.
 */
export function extractStructured(html: string, pageUrl: string): StructuredDraft | undefined {
  if (!html) return undefined;
  const root = parse(html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html, {
    blockTextElements: { script: true, noscript: false, style: false, pre: true },
  });
  const jsonNode = jsonLdRecipe(root);
  const raw = jsonNode ? fromJsonLd(jsonNode, pageUrl) : microdataRecipe(root, pageUrl);
  if (!raw || (!raw.title && raw.ingredients.length === 0)) return undefined;

  const draft: StructuredDraft = {
    confidence: 'structured',
    recipe: {
      title: raw.title || 'Untitled recipe',
      sourceUrl: pageUrl,
      servings: raw.servings,
      ingredients: raw.ingredients.map((l) => toMetric(parseIngredient(l))),
      steps: raw.steps.map(convertTemperatures),
      tags: raw.tags,
    },
  };
  if (raw.image) draft.imageUrl = raw.image;
  return draft;
}

import { parse, type HTMLElement } from 'node-html-parser';

/** Hosts treated as Instagram (https only, exact match after lowercasing and dropping one trailing dot). */
export const INSTAGRAM_HOSTS: readonly string[] = ['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am'];

export function isInstagramUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' && INSTAGRAM_HOSTS.includes(u.hostname.toLowerCase().replace(/\.$/, ''));
  } catch {
    return false;
  }
}

// Same style of budgets as extract-structured.ts: bounded work on hostile pages, nothing is executed.
const MAX_HTML = 5_000_000;
const MAX_JSON_BLOCKS = 25;
const MAX_JSON_BLOCK = 1_000_000;
const MAX_NODES = 20_000;
const MAX_DEPTH = 12;
const MAX_CAPTION = 20_000;
const MIN_CAPTION = 40;

type Json = unknown;
const isObj = (v: Json): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function meta(root: HTMLElement, attr: 'property' | 'name', key: string): string | undefined {
  for (const m of root.querySelectorAll('meta').slice(0, 200)) {
    if (m.getAttribute(attr)?.trim().toLowerCase() === key) {
      const c = m.getAttribute('content');
      if (c !== undefined) return c;
    }
  }
  return undefined;
}

function isLoginWall(root: HTMLElement): boolean {
  const title = root.querySelector('title')?.text ?? '';
  const url = meta(root, 'property', 'og:url') ?? '';
  return /login/i.test(title) && /\/accounts\/login/i.test(url);
}

/** Drop the "N likes, M comments - user on date:" (or "Name on Instagram:") wrapper and the surrounding quotes. */
function clean(raw: string): string {
  let t = raw.replace(/\r\n?/g, '\n').trim();
  t = t.replace(/^[^:"\n]{0,200}?\bon (?:[A-Za-z]+ \d{1,2}, \d{4}|Instagram):\s*["“]?/, '');
  t = t.replace(/["”]\.?\s*$/, '');
  t = t.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, MAX_CAPTION);
}

function usable(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const t = clean(text);
  if (t.length < MIN_CAPTION || /(\.\.\.|…)$/.test(t)) return undefined;
  return t;
}

/** Breadth-first search for a caption/articleBody string with node and depth budgets. */
function findCaption(root: Json): string | undefined {
  const queue: Array<[Json, number]> = [[root, 0]];
  let seen = 0;
  for (let i = 0; i < queue.length && seen < MAX_NODES; i++) {
    const [v, depth] = queue[i];
    seen++;
    if (Array.isArray(v)) {
      if (depth < MAX_DEPTH) for (const x of v.slice(0, MAX_NODES)) queue.push([x, depth + 1]);
    } else if (isObj(v)) {
      for (const k of ['caption', 'articleBody']) {
        const s = v[k];
        if (typeof s === 'string' && usable(s)) return s;
      }
      if (depth < MAX_DEPTH) for (const k of Object.keys(v)) if (isObj(v[k]) || Array.isArray(v[k])) queue.push([v[k], depth + 1]);
    }
  }
  return undefined;
}

function jsonLdCaption(root: HTMLElement): string | undefined {
  const scripts = root.querySelectorAll('script').filter((s) => /^application\/ld\+json\b/i.test(s.getAttribute('type')?.trim() ?? ''));
  for (const s of scripts.slice(0, MAX_JSON_BLOCKS)) {
    const body = s.rawText.trim();
    if (!body || body.length > MAX_JSON_BLOCK) continue;
    try {
      const c = findCaption(JSON.parse(body));
      if (c) return c;
    } catch {
      /* ignore bad block */
    }
  }
  return undefined;
}

/** Caption text of an Instagram post page, or undefined (login wall, missing, too short, truncated). */
export function extractInstagramCaption(html: string): string | undefined {
  if (typeof html !== 'string' || !html || html.length > MAX_HTML) return undefined;
  const root = parse(html);
  if (isLoginWall(root)) return undefined;
  const candidates = [
    () => meta(root, 'property', 'og:description'),
    () => meta(root, 'name', 'description'),
    () => meta(root, 'property', 'og:title'),
    () => jsonLdCaption(root),
  ];
  for (const get of candidates) {
    const t = usable(get());
    if (t) return t;
  }
  return undefined;
}

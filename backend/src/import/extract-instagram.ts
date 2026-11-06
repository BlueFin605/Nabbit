import { parse, type HTMLElement } from 'node-html-parser';

/** Hosts treated as Instagram (https only, exact match after lowercasing and dropping one trailing dot). */
export const INSTAGRAM_HOSTS: readonly string[] = ['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am'];

/**
 * E2E hook: extra hostnames (comma separated) that count as Instagram, so a fixture host can exercise the
 * auto-fetch path. Honoured ONLY when NODE_ENV=development (the local dev server); a production build ignores it.
 */
function e2eInstagramHosts(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== 'development' || !env.NABBIT_E2E_INSTAGRAM_HOSTS) return [];
  return env.NABBIT_E2E_INSTAGRAM_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

export function isInstagramUrl(rawUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return u.protocol === 'https:' && (INSTAGRAM_HOSTS.includes(host) || e2eInstagramHosts(env).includes(host));
  } catch {
    return false;
  }
}

const POST_PATH = /^\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/;

/**
 * Canonical form of an Instagram URL: a post URL becomes https://www.instagram.com/{p|reel|reels|tv}/{id}/ (share params,
 * fragment and a leading /{user}/ dropped); any other URL just loses its query string and fragment. Unparseable input is returned as is.
 */
export function canonicalInstagramUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    const m = POST_PATH.exec(u.pathname);
    if (m && INSTAGRAM_HOSTS.includes(host)) return `https://www.instagram.com/${m[1]}/${m[2]}/`;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return rawUrl;
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

/** Generic text Instagram shows on its login/signup interstitials instead of a caption. */
const GENERIC_WALL_TEXT = /create an account or log ?in to instagram|^\s*log ?in to instagram|^\s*sign up (?:for|to) instagram/i;

function isLoginWall(root: HTMLElement): boolean {
  const title = root.querySelector('title')?.text ?? '';
  const url = meta(root, 'property', 'og:url') ?? '';
  return /^\s*(?:log ?in|sign ?up)\b/i.test(title) || /\/accounts\/(?:login|emailsignup)|\/challenge\b/i.test(url);
}

const WRAPPERS: readonly RegExp[] = [
  // "1,781 likes, 28 comments - Display Name on May 11, 2024: "caption"" (the name may contain ':' or quotes)
  /^\d[\d,.]*[KkMm]?\s+likes?,[^\n]{0,300}?\bon\b[^\n]{0,200}?:\s*["“]/,
  // "Name on Instagram: "caption"" (og:title)
  /^[^\n"“]{0,200}?\bon Instagram:\s*["“]/,
  // "name on May 11, 2024: "caption""
  /^[^\n"“]{0,200}?\bon [A-Za-z]+ \d{1,2}, \d{4}:\s*["“]/,
];

/** Drop the "N likes, M comments - user on date:" (or "Name on Instagram:") wrapper and, only then, the surrounding quote. */
function clean(raw: string): string {
  // Bound the work first: nothing past the cap (plus a margin for the wrapper) is ever kept.
  let t = raw.slice(0, MAX_CAPTION + 1_000).replace(/\r\n?/g, '\n').trim();
  let stripped = false;
  for (const re of WRAPPERS) {
    const m = re.exec(t);
    if (m) {
      t = t.slice(m[0].length);
      stripped = true;
      break;
    }
  }
  if (stripped) t = t.replace(/["”]\.?\s*$/, '');
  t = t.split('\n').map((l) => l.trimEnd()).join('\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t.slice(0, MAX_CAPTION);
}

function usable(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const t = clean(text);
  if (GENERIC_WALL_TEXT.test(text.trim()) || GENERIC_WALL_TEXT.test(t) || t.length < MIN_CAPTION || /(\.\.\.|…)$/.test(t)) return undefined;
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

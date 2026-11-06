import { parse, type HTMLElement } from "node-html-parser";

/** Max image candidates returned from an import. */
export const MAX_CANDIDATES = 6;

// Limits keeping work bounded on hostile or pathological pages.
const MAX_HTML = 5_000_000;
const MAX_NODES = 20_000;
const MAX_DEPTH = 64;
const MIN_DIMENSION = 100;
const EXCLUDE = /(sprite|icon|logo|avatar|pixel|tracking|badge)/i;

/** Absolute https URL or undefined (resolves relative against `base`; drops http, data and unparseable). */
function toHttps(v: string | undefined, base: string): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v.trim(), base);
    return u.protocol === "https:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const dim = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

/** Iterative document-order walk collecting <meta> and <img>, bounded by node and depth budgets. */
function collect(root: HTMLElement): {
  metas: HTMLElement[];
  imgs: HTMLElement[];
} {
  const metas: HTMLElement[] = [];
  const imgs: HTMLElement[] = [];
  const stack: Array<[HTMLElement, number]> = [[root, 0]];
  let seen = 0;
  while (stack.length && seen < MAX_NODES) {
    const [el, depth] = stack.pop()!;
    seen++;
    const tag = el.tagName?.toLowerCase();
    if (tag === "meta") metas.push(el);
    else if (tag === "img") imgs.push(el);
    if (depth >= MAX_DEPTH) continue;
    const kids = el.childNodes;
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i] as HTMLElement;
      if (k.nodeType === 1) stack.push([k, depth + 1]);
    }
  }
  return { metas, imgs };
}

/**
 * Ranked, de-duplicated absolute https image URLs for a page: the structured
 * (JSON-LD/microdata) image, then og:image / twitter:image, then scored <img> tags.
 * Pure and synchronous; the HTML is parsed, never executed.
 */
export function extractImageCandidates(
  html: string,
  pageUrl: string,
  structuredImage?: string,
): string[] {
  const out: string[] = [];
  const add = (v: string | undefined) => {
    const u = toHttps(v, pageUrl);
    if (u && !out.includes(u) && out.length < MAX_CANDIDATES) out.push(u);
  };

  add(structuredImage);
  if (!html || out.length >= MAX_CANDIDATES) return out;

  const root = parse(html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html, {
    blockTextElements: {
      script: true,
      noscript: false,
      style: false,
      pre: true,
    },
  });
  const { metas, imgs } = collect(root);

  for (const key of ["og:image", "twitter:image"]) {
    for (const m of metas) {
      const k = (
        m.getAttribute("property") ??
        m.getAttribute("name") ??
        ""
      ).toLowerCase();
      if (k === key) add(m.getAttribute("content"));
    }
  }

  const scored: Array<{ src: string; area: number; pos: number }> = [];
  imgs.forEach((img, pos) => {
    const src = img.getAttribute("src");
    if (!src || EXCLUDE.test(src)) return;
    const w = dim(img.getAttribute("width"));
    const h = dim(img.getAttribute("height"));
    if (
      (w !== undefined && w < MIN_DIMENSION) ||
      (h !== undefined && h < MIN_DIMENSION)
    )
      return;
    scored.push({ src, area: (w ?? 0) * (h ?? 0), pos });
  });
  scored.sort((a, b) => b.area - a.area || a.pos - b.pos);
  for (const s of scored) add(s.src);
  return out;
}

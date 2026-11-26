import { parse, type Node as HtmlNode, type HTMLElement } from 'node-html-parser';
import { MAX_STEP_COUNT, convertTemperatures, normaliseUnit, parseIngredient, toMetric } from '@nabbit/recipe-core';
import type { RecipeDraft, StepGroup, StepNode } from '@nabbit/recipe-core';

// Limits keeping work bounded on hostile or pathological input.
const MAX_INPUT = 200_000;
const MAX_HTML = 2_000_000;
const MAX_OUTPUT = 500_000;
const MAX_NODES = 100_000;
const MAX_TAG_SCAN = 200_000;
const MAX_NEST = 2_000;
const MAX_LINES = 3_000;
const MAX_LINE = 500;
const MAX_TITLE = 120;
const MAX_ITEMS = 200;
const MAX_TAGS = 10;
const DEFAULT_SERVINGS = 4;

export interface TextExtractOptions {
  sourceUrl?: string;
  titleHint?: string;
}

// ---- HTML -> text ----

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'head', 'svg', 'template', 'form', 'iframe', 'select', 'button']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'br', 'tr', 'table', 'section', 'article', 'main', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dt', 'dd', 'dl', 'figure', 'figcaption', 'hr', 'details', 'summary',
]);

const NO_NEST = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'p', 'li', 'td', 'th', 'tr', 'dt', 'dd', 'option']);

/**
 * node-html-parser is quadratic on deeply nested unclosed tags, so cut the
 * markup off where nesting gets absurd (one linear pass, bounded tag count).
 */
function limitNesting(html: string): string {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g;
  let depth = 0;
  let tags = 0;
  for (let m = re.exec(html); m && tags < MAX_TAG_SCAN; m = re.exec(html), tags++) {
    const name = m[2].toLowerCase();
    if (NO_NEST.has(name) || m[3]) continue;
    if (m[1]) depth = Math.max(0, depth - 1);
    else if (++depth > MAX_NEST) return html.slice(0, m.index);
  }
  return html;
}

/**
 * Plain text from a page with no structured data: drops script/style/nav and
 * other chrome, keeps block-level elements as line breaks. Pure; never throws.
 */
export function htmlToText(html: string): string {
  try {
    if (typeof html !== 'string' || !html) return '';
    const capped = limitNesting(html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html).replace(/<!doctype[^>]*>/i, '');
    const root = parse(capped, {
      blockTextElements: { script: true, noscript: true, style: true, pre: true },
    });
    let out = '';
    let seen = 0;
    // Iterative walk: a string on the stack is literal output (a line break after a block).
    const stack: Array<HtmlNode | string> = [root];
    while (stack.length && seen < MAX_NODES && out.length < MAX_OUTPUT) {
      const n = stack.pop()!;
      if (typeof n === 'string') {
        out += n;
        continue;
      }
      seen++;
      if (n.nodeType === 3) {
        out += n.text.replace(/\s+/g, ' ');
      } else if (n.nodeType === 1) {
        const tag = (n as HTMLElement).tagName?.toLowerCase();
        if (tag && SKIP_TAGS.has(tag)) continue;
        const block = !!tag && BLOCK_TAGS.has(tag);
        if (block) stack.push('\n');
        for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]);
        if (block) stack.push('\n');
      } else {
        for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]);
      }
    }
    return out
      .slice(0, MAX_OUTPUT)
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

// ---- text -> draft ----

const ING_HEADING = /^(?:ingredients?|what you need|you(?:'|’)?ll need|you will need)$/i;
const METHOD_HEADING = /^(?:method|directions?|instructions?|steps?|preparation)$/i;
const OTHER_HEADING = /^(?:notes?|tips?|nutrition|storage|equipment)$/i;

const SERVINGS_LINE = /^(?:serves|servings?|makes|yields?|feeds)\b|^\d+\s+servings?\b/i;
const SERVINGS_ANY = [/\b(?:serves|servings?|makes|yields?|feeds)\s*:?\s*(\d{1,3})\b/i, /\b(\d{1,3})\s+servings?\b/i];

const HASHTAG = /#[\p{L}][\p{L}\p{N}_]*/gu;
const LEAD_DECOR = /^(?:[\s\p{Extended_Pictographic}•▪●◦·*\-–—]|‍|️|⃣)+/u;
const KEYCAP = /^\d️?⃣\s*/u;
const NUMBERED = /^(?:step\s*\d+\s*[:.)\-–]?\s*|\d{1,3}\s*[.):]\s+)/i;
const NUMBERED_ONLY = /^(?:step\s*\d+\s*[:.)\-–]?\s*|\d{1,3}\s*[.):])$/i;
const EXTRA_UNITS = new Set(['pinch', 'dash', 'handful', 'clove', 'cloves', 'can', 'cans', 'tin', 'tins', 'bunch', 'sprig', 'sprigs', 'slice', 'slices', 'stick', 'sticks', 'packet', 'knob', 'splash']);
const ARTICLE = /^(?:a|an|one|two|three|four|half|some)\s+(?:(?:large|small|medium|heaped|level|generous|good|big)\s+)?([\p{L}.]+)/iu;

const isUnitWord = (w: string): boolean => {
  const k = w.toLowerCase().replace(/[.,]+$/, '');
  return k.length >= 2 && (EXTRA_UNITS.has(k) || normaliseUnit(k) !== undefined);
};

function startsWithQuantity(s: string): boolean {
  if (NUMBERED.test(s) || NUMBERED_ONLY.test(s)) return false;
  if (/^[\d¼½¾⅓⅔⅛⅜⅝⅞⅕⅙]/.test(s)) return true;
  const art = ARTICLE.exec(s);
  if (art) return isUnitWord(art[1]);
  const first = /^[\p{L}.]+/u.exec(s)?.[0];
  return !!first && isUnitWord(first);
}

const isSentence = (s: string): boolean => s.length > 40 && /[.!?]["')\]]?$/.test(s);

/** One raw line -> display text; collects hashtags. Drops emoji bullets and markdown emphasis. */
function cleanLine(raw: string, tags: Set<string>): string {
  let s = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
  s = s.replace(HASHTAG, (m) => {
    if (tags.size < MAX_TAGS) tags.add(m.slice(1).toLowerCase());
    return ' ';
  });
  s = s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
  s = s.replace(KEYCAP, '').replace(LEAD_DECOR, '');
  return s.trim();
}

function headingKind(s: string): 'ing' | 'method' | 'other' | undefined {
  if (s.length > 40) return undefined;
  const core = s.replace(/^#+\s*/, '').replace(/[:\s]+$/, '').trim();
  if (ING_HEADING.test(core)) return 'ing';
  if (METHOD_HEADING.test(core)) return 'method';
  if (OTHER_HEADING.test(core)) return 'other';
  return undefined;
}

// ---- whole-page paste (page chrome around a recipe card) ----

const JUMP_TO_RECIPE = /^jump to recipe$/i;
const RATING_NUM = /^[0-5](?:\.\d)?$/;
const RATING_COUNT = /^\(\d[\d,]*\)$/;
const RATING_META = /^(?:\d[\d,]*\s+(?:reviews?|ratings?|photos?|comments?)|print|save|share|rate|pin|jump to recipe)$/i;
const NAV_WORDS = /^(?:skip to (?:main )?content|home|menu|search(?: the site)?|recipes?|newsletters?|sweepstakes|about(?: us)?|contact|log ?in|sign ?(?:in|up)|subscribe|videos?|news|shop|cuisines?|occasions?|ingredients?|categories|breadcrumbs?)$/i;
/** A scale toggle ("1/2x", "2X") or the "Original recipe (1X) yields N servings" caption. */
const SCALE_TOGGLE = /^\d+(?:\/\d+)?\s*x$/i;
const ORIGINAL_YIELD = /^original recipe\b/i;
/** Photo credit lines ("Photographer: ...", "Photo: ..."). */
const PHOTO_CREDIT = /^(?:photograph(?:er|y)|photos?(?: credit)?|image(?: credit)?)\s*:/i;
/** Lines that end the recipe card: whatever follows is not part of the recipe. */
const END_MARKER = /^(?:from the editor|editor'?s? note|nutrition(?: facts| information)?\b|reviews?\s*(?:\(\d+\))?:?$|most[- ]saved|[\w ]*\bcommunity tips\b|you (?:might|may) also like|related recipes|more recipes|comments?\s*(?:\(\d+\))?:?$|leave a (?:comment|review))/i;
const MAX_GROUP_HEADING = 60;

/** Drops photo credits and the caption line (no sentence punctuation) that precedes one. */
function dropPhotoCredits(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (PHOTO_CREDIT.test(lines[i])) continue;
    if (i + 1 < lines.length && PHOTO_CREDIT.test(lines[i + 1]) && !/[.!?]["')\]]?$/.test(lines[i])) continue;
    out.push(lines[i]);
  }
  return out;
}

const plausibleTitle = (l: string): boolean =>
  l.length <= MAX_TITLE && !NAV_WORDS.test(l) && !headingKind(l) && !SERVINGS_LINE.test(l) && !startsWithQuantity(l) && !NUMBERED.test(l);

/**
 * For a pasted web page: index of the title line just before the recipe card's
 * rating block / "Jump to Recipe" marker, or -1 when the text has no such marker.
 */
function findPageTitle(lines: string[]): number {
  let marker = lines.findIndex((l, i) => RATING_NUM.test(l) && RATING_COUNT.test(lines[i + 1] ?? ''));
  if (marker < 0) marker = lines.findIndex((l) => JUMP_TO_RECIPE.test(l));
  if (marker < 0) return -1;
  for (let i = marker - 1; i >= 0 && marker - i <= 6; i--) {
    if (RATING_META.test(lines[i]) || RATING_NUM.test(lines[i]) || RATING_COUNT.test(lines[i])) continue;
    return plausibleTitle(lines[i]) ? i : -1;
  }
  return -1;
}

const stripStep = (s: string): string => s.replace(NUMBERED, '').trim();

function findServings(lines: string[]): number {
  const ok = (n: number) => Number.isFinite(n) && n >= 1 && n <= 999;
  for (const l of lines) {
    if (!SERVINGS_LINE.test(l)) continue;
    for (const re of SERVINGS_ANY) {
      const m = re.exec(l);
      if (m && ok(parseInt(m[1], 10))) return parseInt(m[1], 10);
    }
  }
  const text = lines.join('\n');
  for (const re of SERVINGS_ANY) {
    const m = re.exec(text);
    if (m && ok(parseInt(m[1], 10))) return parseInt(m[1], 10);
  }
  return DEFAULT_SERVINGS;
}

function validUrl(v: string | undefined): string | undefined {
  if (!v) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function empty(): RecipeDraft {
  return {
    confidence: 'heuristic',
    recipe: { title: '', servings: DEFAULT_SERVINGS, ingredients: [], steps: [], tags: [] },
  };
}

/**
 * Best-effort recipe from pasted text (or htmlToText output). Always returns a
 * draft with confidence 'heuristic' so the UI asks the user to review it.
 * Pure and synchronous; never throws (empty input gives an empty draft).
 */
export function extractFromText(text: string, opts: TextExtractOptions = {}): RecipeDraft {
  try {
    return extract(typeof text === 'string' ? text : '', opts ?? {});
  } catch {
    return empty();
  }
}

function extract(text: string, opts: TextExtractOptions): RecipeDraft {
  const tags = new Set<string>();
  let lines: string[] = [];
  for (const raw of text.slice(0, MAX_INPUT).split(/\r\n|\r|\n/)) {
    if (!raw.trim()) continue;
    const l = cleanLine(raw, tags);
    if (l) lines.push(l);
    if (lines.length >= MAX_LINES) break;
  }

  lines = dropPhotoCredits(lines);
  const draft = empty();
  const hint = typeof opts.titleHint === 'string' ? cleanLine(opts.titleHint, new Set()).slice(0, MAX_TITLE) : '';
  let title = hint;
  const pageTitleAt = title ? -1 : findPageTitle(lines);
  if (pageTitleAt >= 0) {
    title = lines[pageTitleAt];
    lines = lines.slice(pageTitleAt + 1);
  } else if (!title && lines.length) {
    const f = lines[0];
    if (f.length <= MAX_TITLE && !headingKind(f) && !SERVINGS_LINE.test(f) && !startsWithQuantity(f) && !NUMBERED.test(f)) {
      title = f;
      lines.shift();
    }
  }

  const hasHeadings = lines.some((l) => headingKind(l) === 'ing' || headingKind(l) === 'method');
  const ingredients: string[] = [];
  const steps: StepNode[] = [];
  let group: StepGroup | undefined;
  let stepCount = 0;
  const addStep = (s: string): void => {
    if (stepCount >= MAX_STEP_COUNT) return;
    stepCount++;
    (group ? group.steps : steps).push(convertTemperatures(s));
  };
  let section: 'auto' | 'ing' | 'method' | 'other' = 'auto';
  let last: 'ing' | 'step' | undefined;

  for (const l of lines) {
    if (ingredients.length >= MAX_ITEMS && stepCount >= MAX_STEP_COUNT) break;
    if ((section === 'ing' || section === 'method') && l.length <= 60 && END_MARKER.test(l)) break;
    const h = headingKind(l);
    if (h) {
      section = h;
      group = undefined;
      last = undefined;
      continue;
    }
    if (SCALE_TOGGLE.test(l) || ORIGINAL_YIELD.test(l)) continue;
    if (section === 'other' || (section === 'auto' && hasHeadings)) continue;
    if (SERVINGS_LINE.test(l)) continue;
    if (section === 'method') {
      if (l.length <= MAX_GROUP_HEADING && /:$/.test(l) && !NUMBERED.test(l)) {
        const heading = l.replace(/[:\s]+$/, '');
        if (heading) {
          group = { heading, steps: [] };
          steps.push(group);
        }
        last = undefined;
        continue;
      }
      const s = stripStep(l);
      if (s) addStep(s);
      last = 'step';
      continue;
    }
    if (NUMBERED.test(l) || NUMBERED_ONLY.test(l)) {
      const s = stripStep(l);
      if (s) addStep(s);
      last = 'step';
    } else if (startsWithQuantity(l) && !isSentence(l)) {
      ingredients.push(l);
      last = 'ing';
    } else if (isSentence(l)) {
      addStep(l);
      last = 'step';
    } else if (last === 'ing' && l.length <= 60 && !/[.!?]$/.test(l) && !(section === 'ing' && l.endsWith(':'))) {
      ingredients.push(l);
    }
  }

  draft.recipe.title = title.slice(0, MAX_TITLE);
  draft.recipe.servings = findServings(lines);
  draft.recipe.ingredients = ingredients.slice(0, MAX_ITEMS).map((l) => toMetric(parseIngredient(l)));
  draft.recipe.steps = steps.filter((n) => typeof n === 'string' || n.steps.length > 0);
  draft.recipe.tags = [...tags].slice(0, MAX_TAGS);
  const url = validUrl(opts.sourceUrl);
  if (url) draft.recipe.sourceUrl = url;
  return draft;
}

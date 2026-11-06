import { newId } from './id';
import { normaliseUnit } from './units';
import type { Ingredient, Unit } from './types';

const UNICODE_FRACTIONS: Record<string, string> = {
  '¼': '1/4', '½': '1/2', '¾': '3/4',
  '⅓': '1/3', '⅔': '2/3',
  '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6',
  '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};

const NAMED_ENTITIES: Record<string, string> = {
  frac14: '¼', frac12: '½', frac34: '¾', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
  ndash: '-', mdash: '-', amp: '&',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z0-9]+);/gi, (m, n: string) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

const NUM = String.raw`\d+(?:\.\d+)?(?:\s+\d+/\d+)?|\d+/\d+`;
const QTY_RE = new RegExp(String.raw`^(${NUM})(?:\s*(?:[-–]|\bto\b)\s*(${NUM}))?(?![\d/])\s*`, 'i');

function toNumber(s: string): number {
  return s
    .trim()
    .split(/\s+/)
    .reduce((sum, part) => {
      const m = /^(\d+)\/(\d+)$/.exec(part);
      return sum + (m ? Number(m[1]) / Number(m[2]) : Number(part));
    }, 0);
}

function joinNotes(...parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter((p): p is string => !!p && p.length > 0).join(', ');
  return joined || undefined;
}

function build(
  original: string,
  fields: { quantity: number | null; quantityMax?: number; unit: Unit; name: string; note?: string },
): Ingredient {
  const ing: Ingredient = {
    id: newId(),
    original,
    quantity: fields.quantity,
    unit: fields.unit,
    name: fields.name,
    scalable: fields.quantity !== null,
  };
  if (fields.quantityMax !== undefined) ing.quantityMax = fields.quantityMax;
  if (fields.note) ing.note = fields.note;
  return ing;
}

/** Parse a free-text ingredient line. Never throws; always returns an Ingredient. */
export function parseIngredient(line: string): Ingredient {
  try {
    return parse(line);
  } catch {
    return build(line, { quantity: null, unit: '', name: line.trim() });
  }
}

function parse(line: string): Ingredient {
  let s = decodeEntities(line)
    .replace(/[¼½¾⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (c) => ` ${UNICODE_FRACTIONS[c]} `)
    .replace(/^[\s\-–•*·]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleaned = s;

  // Parenthetical -> note
  let parenNote: string | undefined;
  const paren = /\(([^()]*)\)/.exec(s);
  if (paren) {
    parenNote = paren[1].trim() || undefined;
    s = (s.slice(0, paren.index) + ' ' + s.slice(paren.index + paren[0].length)).replace(/\s+/g, ' ').trim();
  }

  // Comma -> note
  let commaNote: string | undefined;
  const comma = s.indexOf(',');
  if (comma >= 0) {
    commaNote = s.slice(comma + 1).trim() || undefined;
    s = s.slice(0, comma).trim();
  }

  const qty = QTY_RE.exec(s);
  if (!qty) {
    let note = joinNotes(parenNote, commaNote);
    let name = s;
    const pinch = /^(?:an?\s+|1\s+)?(pinch|dash)(?:es)?\s+(?:of\s+)?(.+)$/i.exec(name);
    if (pinch) {
      note = joinNotes(pinch[1].toLowerCase(), note);
      name = pinch[2];
    }
    const taste = /^(.*?)[\s,]*\b(to taste|as needed)$/i.exec(name);
    if (taste && taste[1]) {
      note = joinNotes(taste[2].toLowerCase(), note);
      name = taste[1];
    }
    if (!name) name = cleaned;
    return build(line, { quantity: null, unit: '', name, note });
  }

  const quantity = toNumber(qty[1]);
  const max = qty[2] !== undefined ? toNumber(qty[2]) : undefined;
  let rest = s.slice(qty[0].length).trim();

  let unit: Unit = '';
  const words = rest.split(' ');
  for (const n of [2, 1]) {
    if (words.length <= n) continue; // keep at least one word for the name
    const u = normaliseUnit(words.slice(0, n).join(' '));
    if (u !== undefined) {
      unit = u;
      rest = words.slice(n).join(' ');
      break;
    }
  }
  const name = rest.replace(/^of\s+/i, '').trim();
  return build(line, {
    quantity,
    quantityMax: max !== undefined && max > quantity ? max : undefined,
    unit,
    name,
    note: joinNotes(parenNote, commaNote),
  });
}

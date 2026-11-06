import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { detectAppData, extractAppData, findSchemaRecipe, gatsbyDataUrl, reduceAppData, MAX_APP_DATA_CHARS } from '../src/import/extract-app-data.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const SHELL = fx('gatsby-shell.html');
const PAGE_DATA = fx('gatsby-page-data.json');
const PAGE = 'https://recipes.co.nz/recipes/the-best-lasagne/';

const next = (json: unknown) =>
  `<html><head></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(json)}</script></body></html>`;

describe('gatsbyDataUrl', () => {
  it.each([
    ['https://recipes.co.nz/recipes/the-best-lasagne/?gclid=1#x', 'https://recipes.co.nz/page-data/recipes/the-best-lasagne/page-data.json'],
    ['https://recipes.co.nz/recipes/the-best-lasagne', 'https://recipes.co.nz/page-data/recipes/the-best-lasagne/page-data.json'],
    ['https://recipes.co.nz/', 'https://recipes.co.nz/page-data/index/page-data.json'],
  ])('%s', (page, want) => expect(gatsbyDataUrl(page)).toBe(want));
});

describe('detectAppData', () => {
  it('Gatsby shell by chunk mapping', () => {
    expect(detectAppData(SHELL, PAGE)).toEqual({ kind: 'gatsby', dataUrl: 'https://recipes.co.nz/page-data/recipes/the-best-lasagne/page-data.json' });
  });
  it('Gatsby by generator meta (either attribute order)', () => {
    for (const m of ['<meta name="generator" content="Gatsby 5.13.1"/>', '<meta content="Gatsby 4" name="generator">']) {
      expect(detectAppData(`<html><head>${m}</head></html>`, PAGE)?.kind).toBe('gatsby');
    }
  });
  it('Next.js embedded JSON', () => {
    expect(detectAppData(next({ props: { a: 1 } }), 'https://x.example/r')).toEqual({ kind: 'next', json: { props: { a: 1 } } });
  });
  it('malformed __NEXT_DATA__ and plain pages -> undefined', () => {
    expect(detectAppData('<script id="__NEXT_DATA__" type="application/json">{nope</script>', PAGE)).toBeUndefined();
    expect(detectAppData('<html><body><p>hi</p></body></html>', PAGE)).toBeUndefined();
  });
});

describe('reduceAppData', () => {
  const text = reduceAppData(JSON.parse(PAGE_DATA));
  it('keeps recipe strings', () => {
    for (const s of ['The best lasagne', 'Preheat the oven to 180°C.', 'To make mince filling', 'New Zealand beef mince', '1kg', 'finely chopped', '45']) {
      expect(text, s).toContain(s);
    }
  });
  it('drops nav, ad, nutrition, seo, related and excerpt noise', () => {
    for (const s of ['Lamb steaks', 'Iron Rich', 'Beef Recipes', 'Ultimate lasagne recipe', '2628', 'recipe_15', 'Browning mince first', 'This nutrition analysis']) {
      expect(text, s).not.toContain(s);
    }
  });
  it('is small and capped', () => {
    expect(text.length).toBeLessThan(5000);
    const big = { title: 'T', ingredients: Array.from({ length: 5000 }, (_, i) => `ingredient number ${i} with some words`) };
    expect(reduceAppData(big).length).toBeLessThanOrEqual(MAX_APP_DATA_CHARS);
  });
  it('returns empty for json with nothing recipe-like', () => {
    expect(reduceAppData({ foo: 'bar', _id: 'x' })).toBe('');
  });
});

describe('findSchemaRecipe', () => {
  it('finds a nested @type Recipe, including array types', () => {
    const r = { '@type': ['Thing', 'Recipe'], name: 'X' };
    expect(findSchemaRecipe({ props: { pageProps: { seo: [1, { jsonLd: r }] } } })).toBe(r);
    expect(findSchemaRecipe({ a: { '@type': 'Recipe', name: 'Y' } })).toEqual({ '@type': 'Recipe', name: 'Y' });
  });
  it('undefined when absent', () => expect(findSchemaRecipe(JSON.parse(PAGE_DATA))).toBeUndefined());
});

describe('extractAppData', () => {
  const ok = (body: string, url = 'https://recipes.co.nz/page-data/recipes/the-best-lasagne/page-data.json') =>
    vi.fn(async () => ({ url, text: body }));

  it('Gatsby: fetches page-data.json and returns reduced text', async () => {
    const fetchJson = ok(PAGE_DATA);
    const r = await extractAppData(SHELL, PAGE, fetchJson);
    expect(fetchJson).toHaveBeenCalledOnce();
    expect(fetchJson).toHaveBeenCalledWith('https://recipes.co.nz/page-data/recipes/the-best-lasagne/page-data.json');
    expect(r?.text).toContain('Preheat the oven to 180°C.');
    expect(r?.structured).toBeUndefined();
  });
  it('Next: uses embedded JSON, no fetch', async () => {
    const fetchJson = vi.fn();
    const r = await extractAppData(next({ props: { pageProps: { recipe: { title: 'Soup', ingredients: ['1 onion'], method: ['Boil.'] } } } }), 'https://x.example/r', fetchJson);
    expect(fetchJson).not.toHaveBeenCalled();
    expect(r?.text).toContain('Boil.');
  });
  it('schema.org Recipe in the JSON -> structured draft', async () => {
    const recipe = { '@type': 'Recipe', name: 'Pancakes', recipeYield: '4', recipeIngredient: ['1 cup flour', '2 eggs'], recipeInstructions: ['Mix.', 'Cook.'] };
    const r = await extractAppData(next({ props: { recipe } }), 'https://x.example/r', vi.fn());
    expect(r?.structured?.confidence).toBe('structured');
    expect(r?.structured?.recipe.title).toBe('Pancakes');
    expect(r?.structured?.recipe.ingredients).toHaveLength(2);
    expect(r?.text).toBeUndefined();
  });
  it('non-Gatsby/Next pages fetch nothing', async () => {
    const fetchJson = vi.fn();
    expect(await extractAppData('<html><body>hi</body></html>', PAGE, fetchJson)).toBeUndefined();
    expect(fetchJson).not.toHaveBeenCalled();
  });
  it('fetch failure (404 etc.) -> undefined', async () => {
    const boom = vi.fn(async (): Promise<{ url: string; text: string }> => {
      throw new Error('bad_status');
    });
    expect(await extractAppData(SHELL, PAGE, boom)).toBeUndefined();
  });
  it('cross-origin final url (redirect) is rejected', async () => {
    expect(await extractAppData(SHELL, PAGE, ok(PAGE_DATA, 'https://evil.example/page-data.json'))).toBeUndefined();
  });
  it('oversized JSON is rejected', async () => {
    expect(await extractAppData(SHELL, PAGE, ok(JSON.stringify({ title: 'x'.repeat(1_100_000) })))).toBeUndefined();
  });
  it('non-JSON body -> undefined', async () => {
    expect(await extractAppData(SHELL, PAGE, ok('<html>not json</html>'))).toBeUndefined();
  });
});

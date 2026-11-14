import { describe, expect, it, vi } from 'vitest';
import { candidateRecipeLinks, SKIP_HOST_PATTERNS, tryLinkedRecipe } from '../src/import/youtube-links.js';
import type { ImportDeps } from '../src/routes/import.js';
import { ImportError } from '../src/import/import-error.js';
import * as llm from '../src/import/llm-parse.js';

describe('candidateRecipeLinks', () => {
  it('extracts https links, strips trailing punctuation, dedupes and keeps order', () => {
    const d = 'Recipe: https://blog.example.com/pasta. Again https://blog.example.com/pasta, and (https://other.example.org/x) ok http://insecure.example.com/y';
    expect(candidateRecipeLinks(d)).toEqual(['https://blog.example.com/pasta', 'https://other.example.org/x']);
  });
  it('drops YouTube/Google hosts and the skip list', () => {
    const skipped = [
      'https://www.youtube.com/watch?v=abcdEFGhij1', 'https://youtu.be/abcdEFGhij1', 'https://www.google.com/x', 'https://goo.gl/abc',
      'https://www.instagram.com/u', 'https://tiktok.com/@u', 'https://www.facebook.com/u', 'https://twitter.com/u', 'https://x.com/u',
      'https://www.patreon.com/u', 'https://www.amazon.com/dp/1', 'https://amazon.co.uk/dp/1', 'https://amzn.to/1', 'https://a.co/d/1',
      'https://bit.ly/1', 'https://linktr.ee/u', 'https://shop.example.com/p', 'https://store.myshopify.com/p', 'https://ko-fi.com/u',
      'https://paypal.me/u', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', 'https://192.168.1.2/x',
    ];
    expect(candidateRecipeLinks(skipped.join('\n'))).toEqual([]);
    expect(SKIP_HOST_PATTERNS.length).toBeGreaterThan(5);
  });
  it('does not treat lookalike hosts as skipped', () => {
    expect(candidateRecipeLinks('https://notamazon.example.com/x https://example.com/boxer')).toEqual([
      'https://notamazon.example.com/x',
      'https://example.com/boxer',
    ]);
  });
  it('caps at max (default 3) after filtering', () => {
    const d = ['https://www.youtube.com/a', 'https://a.example.com/', 'https://b.example.com/', 'https://c.example.com/', 'https://d.example.com/'].join(' ');
    expect(candidateRecipeLinks(d)).toEqual(['https://a.example.com/', 'https://b.example.com/', 'https://c.example.com/']);
    expect(candidateRecipeLinks(d, 1)).toEqual(['https://a.example.com/']);
  });
});

const recipePage = (title: string, img = 'https://img.example.com/p.jpg') =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: title,
    image: img,
    recipeIngredient: ['1 cup flour', '2 eggs'],
    recipeInstructions: ['Mix.', 'Bake.'],
  })}</script></head><body><h1>${title}</h1></body></html>`;

const fakeDeps = (pages: Record<string, string | Error>) => {
  const safeFetch = vi.fn(async (url: string) => {
    const p = pages[url];
    if (p === undefined) throw new ImportError('blocked_address');
    if (p instanceof Error) throw p;
    return { url, html: p };
  });
  return { safeFetch, deps: { safeFetch } as unknown as ImportDeps };
};

describe('tryLinkedRecipe', () => {
  it('skips a non-structured shop page and returns the next structured link', async () => {
    const { deps, safeFetch } = fakeDeps({
      'https://shop.example.com/': '<html><body><p>Buy my stuff</p></body></html>',
      'https://blog.example.com/pasta': recipePage('Pasta'),
    });
    const r = await tryLinkedRecipe(['https://shop.example.com/', 'https://blog.example.com/pasta'], deps);
    expect(r?.url).toBe('https://blog.example.com/pasta');
    expect(r?.recipe.confidence).toBe('structured');
    expect(r?.recipe.recipe.title).toBe('Pasta');
    expect(r?.recipe.recipe).not.toHaveProperty('imageUrl');
    expect(r?.imageUrl).toBe('https://img.example.com/p.jpg');
    expect(r?.candidates?.[0]).toBe('https://img.example.com/p.jpg');
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });
  it('moves on after fetch errors and returns undefined when everything fails', async () => {
    const { deps } = fakeDeps({ 'https://a.example.com/': new Error('boom'), 'https://b.example.com/': '<p>nothing</p>' });
    expect(await tryLinkedRecipe(['https://a.example.com/', 'https://b.example.com/', 'https://c.example.com/'], deps)).toBeUndefined();
    expect(await tryLinkedRecipe([], deps)).toBeUndefined();
  });
  it('never calls the LLM parser', async () => {
    const spy = vi.spyOn(llm, 'getLlmParser');
    const { deps } = fakeDeps({ 'https://a.example.com/': '<p>x</p>', 'https://b.example.com/': recipePage('B') });
    await tryLinkedRecipe(['https://a.example.com/', 'https://b.example.com/'], deps);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
  it('rejects a link that redirects to a YouTube host', async () => {
    const safeFetch = vi.fn(async () => ({ url: 'https://www.youtube.com/watch?v=abcdEFGhij1', html: recipePage('X') }));
    expect(await tryLinkedRecipe(['https://a.example.com/'], { safeFetch } as unknown as ImportDeps)).toBeUndefined();
  });
});

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { MAX_STEP_COUNT, countSteps } from '@nabbit/recipe-core';
import { extractFromText } from '../src/import/extract-text.js';
import { extractStructured } from '../src/import/extract-structured.js';
import { handler, resetRoutes } from '../src/router.js';
import { registerRecipeRoutes } from '../src/routes/recipes.js';
import { setDb } from '../src/db.js';
import { createMemoryDb } from '../src/db-memory.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

const post = async (body: unknown) => {
  const ev = {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/recipes',
    rawQueryString: '',
    headers: {},
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method: 'POST', path: '/recipes' }, authorizer: { jwt: { claims: { sub: 'u1' }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2;
  const res = (await handler(ev)) as { statusCode: number; body?: string };
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
};

const saveable = (d: { recipe: { title: string; servings: number; ingredients: unknown[]; steps: unknown[]; tags: string[] } }) => ({
  ...d.recipe,
  title: d.recipe.title || 'Imported',
  ingredients: (d.recipe.ingredients as Array<Record<string, unknown>>).map((i) => ({ ...i, id: undefined })),
});

beforeEach(() => {
  setDb(createMemoryDb());
  resetRoutes();
  registerRecipeRoutes();
});

describe('import step cap', () => {
  it('caps long text imports at MAX_STEP_COUNT and the draft is saveable', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `Stir the pot gently for ${i + 1} minutes.`);
    const d = extractFromText(`Big Stew\n\nDirections\n${lines.join('\n')}`);
    expect(countSteps(d.recipe.steps)).toBeLessThanOrEqual(MAX_STEP_COUNT);
    expect(countSteps(d.recipe.steps)).toBe(MAX_STEP_COUNT);
    expect((await post(saveable(d))).status).toBe(201);
  });

  it('caps a pasted web page with extra review lines and the draft is saveable', async () => {
    const extra = Array.from({ length: 150 }, (_, i) => `Reviewer ${i} said this was a lovely batter.`);
    const d = extractFromText(`${fx('allrecipes-fish-batter-paste.txt')}\n${extra.join('\n')}`);
    expect(countSteps(d.recipe.steps)).toBeLessThanOrEqual(MAX_STEP_COUNT);
    expect((await post(saveable(d))).status).toBe(201);
  });

  it('caps structured (JSON-LD) imports at MAX_STEP_COUNT', () => {
    const steps = Array.from({ length: 150 }, (_, i) => ({ '@type': 'HowToStep', text: `Do thing ${i + 1}.` }));
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@type': 'Recipe',
      name: 'Long',
      recipeIngredient: ['1 cup flour'],
      recipeInstructions: steps,
    })}</script></head></html>`;
    const d = extractStructured(html, 'https://example.com/r')!;
    expect(countSteps(d.recipe.steps)).toBeLessThanOrEqual(MAX_STEP_COUNT);
  });
});

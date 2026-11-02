import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { start } from '../src/local';
import { createMemoryDb } from '../src/db-memory';
import { setDb } from '../src/db';
import { CHECKED, LIST_ITEMS, LIST_NAME, RECIPES, seed } from '../scripts/seed-local.mjs';

// Runs the real seed against the real route handlers over HTTP with the in-memory db, so the payloads
// cannot drift from the route validators.
let server: Server;
let base: string;
const prevEnv = process.env.NODE_ENV;

beforeAll(async () => {
  process.env.NODE_ENV = 'development'; // X-Dev-Sub is honoured only in development
  server = await start(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  process.env.NODE_ENV = prevEnv;
  setDb(undefined);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => setDb(createMemoryDb()));

const get = async (path: string, sub = 'dev-user') =>
  (await fetch(`${base}${path}`, { headers: { 'x-dev-sub': sub } })).json() as Promise<{ id: string; title?: string; name?: string; items?: { name: string; checked: boolean }[] }[]>;

describe('seed data shape', () => {
  it('covers the features the ticket asks for', () => {
    expect(RECIPES).toHaveLength(6);
    expect(new Set(RECIPES.map((r) => r.title)).size).toBe(RECIPES.length);
    const all = RECIPES.flatMap((r) => (r.ingredients as { unit: string; quantity: number | null; quantityMax?: number; note?: string }[]));
    expect(all.some((i) => i.unit === 'cup')).toBe(true);
    expect(all.some((i) => i.unit === 'oz')).toBe(true);
    expect(all.some((i) => i.quantity === null && i.note === 'to taste')).toBe(true);
    expect(all.some((i) => i.quantityMax !== undefined)).toBe(true);
    expect(all.some((i) => i.note)).toBe(true);
    expect(RECIPES.some((r) => (r.tags as string[]).length > 0)).toBe(true);
    expect(RECIPES.some((r) => r.sourceUrl)).toBe(true);
    expect(LIST_ITEMS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(LIST_ITEMS.map((i) => i.category)).size).toBeGreaterThan(2);
    for (const c of CHECKED) expect(LIST_ITEMS.some((i) => i.name === c)).toBe(true);
  });
});

describe('seed()', () => {
  it('creates everything through the API and is idempotent', async () => {
    const first = await seed({ apiUrl: base });
    expect(first).toMatchObject({ recipesCreated: 6, recipesSkipped: 0, listCreated: true, items: LIST_ITEMS.length, checked: CHECKED.length });
    const second = await seed({ apiUrl: base });
    expect(second).toMatchObject({ recipesCreated: 0, recipesSkipped: 6, listCreated: false });

    expect(await get('/recipes')).toHaveLength(6);
    const lists = await get('/lists');
    expect(lists).toHaveLength(1);
    const list = (await (await fetch(`${base}/lists/${lists[0]!.id}`, { headers: { 'x-dev-sub': 'dev-user' } })).json()) as { name: string; items: { name: string; checked: boolean }[] };
    expect(list.name).toBe(LIST_NAME);
    expect(list.items.filter((i) => i.checked).map((i) => i.name).sort()).toEqual([...CHECKED].sort());
    // item memory feeds autocomplete
    expect(await get('/items/suggest?q=mil')).toEqual([{ name: 'milk', category: 'Dairy' }]);
  });

  it('--reset recreates the seeded data without duplicating', async () => {
    await seed({ apiUrl: base });
    const again = await seed({ apiUrl: base, reset: true });
    expect(again).toMatchObject({ recipesDeleted: 6, listsDeleted: 1, recipesCreated: 6, listCreated: true });
    expect(await get('/recipes')).toHaveLength(6);
    expect(await get('/lists')).toHaveLength(1);
  });

  it('leaves other users and the seed user\'s other data alone', async () => {
    await fetch(`${base}/recipes`, {
      method: 'POST',
      headers: { 'x-dev-sub': 'other', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Mine', servings: 1, ingredients: [], steps: [], tags: [] }),
    });
    await fetch(`${base}/recipes`, {
      method: 'POST',
      headers: { 'x-dev-sub': 'dev-user', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Hand made', servings: 1, ingredients: [], steps: [], tags: [] }),
    });
    await seed({ apiUrl: base, reset: true });
    expect(await get('/recipes', 'other')).toHaveLength(1);
    expect(await get('/recipes')).toHaveLength(7);
  });

  it('fails loudly on an API error', async () => {
    await expect(seed({ apiUrl: base, sub: '' })).rejects.toThrow(/401/);
  });
});

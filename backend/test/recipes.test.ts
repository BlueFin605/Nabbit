import { beforeEach, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, resetRoutes } from '../src/router.js';
import { registerRecipeRoutes } from '../src/routes/recipes.js';
import { setDb } from '../src/db.js';
import { createMemoryDb } from '../src/db-memory.js';

function event(method: string, path: string, sub: string, body?: unknown, query = ''): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: query,
    headers: {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method, path }, authorizer: { jwt: { claims: { sub }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2;
}
const call = async (method: string, path: string, sub: string, body?: unknown, query = '') => {
  const res = (await handler(event(method, path, sub, body, query))) as {
    statusCode: number;
    body?: string;
  };
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
};

const draft = (over: Record<string, unknown> = {}) => ({
  title: 'Pancakes',
  servings: 4,
  ingredients: [
    { id: 'i1', quantity: 2, unit: 'cup', name: 'flour', scalable: true },
    { id: 'i2', quantity: null, unit: '', name: 'salt', scalable: false },
  ],
  steps: ['Mix', 'Fry'],
  tags: ['breakfast'],
  ...over,
});

let db: ReturnType<typeof createMemoryDb>;
beforeEach(() => {
  db = createMemoryDb();
  setDb(db);
  resetRoutes();
  registerRecipeRoutes();
});

const create = async (sub = 'u1', over = {}) => (await call('POST', '/recipes', sub, draft(over))).json;

describe('create and get', () => {
  it('round-trips, assigns id/version/timestamps and fills metric', async () => {
    const res = await call('POST', '/recipes', 'u1', draft());
    expect(res.status).toBe(201);
    expect(res.json.id).toBeTruthy();
    expect(res.json.version).toBe(1);
    expect(res.json.createdAt).toBe(res.json.updatedAt);
    expect(res.json.ingredients[0].metric).toEqual({ quantity: 480, unit: 'ml' });
    expect(res.json.ingredients[1].metric).toBeUndefined();
    const got = await call('GET', `/recipes/${res.json.id}`, 'u1');
    expect(got.status).toBe(200);
    expect(got.json).toEqual(res.json);
    expect(got.json.pk).toBeUndefined();
    expect(got.json.ttl).toBeUndefined();
  });

  it('ignores client-supplied id/version/ownership fields', async () => {
    const r = await create('u1', { id: 'evil', version: 99, pk: 'OWNER#x' });
    expect(r.id).not.toBe('evil');
    expect(r.version).toBe(1);
    expect(db.items.size).toBe(1);
    expect([...db.items.values()][0]!.pk).toBe('OWNER#u1');
  });

  it('404 for unknown id', async () => {
    expect((await call('GET', '/recipes/nope', 'u1')).status).toBe(404);
  });
});

describe('validation', () => {
  const manyIngredients = Array.from({ length: 201 }, () => ({ quantity: 1, unit: 'g', name: 'a', scalable: true }));
  it.each([
    ['empty title', { title: '  ' }],
    ['missing title', { title: undefined }],
    ['long title', { title: 'x'.repeat(201) }],
    ['too many ingredients', { ingredients: manyIngredients }],
    ['too many steps', { steps: Array.from({ length: 101 }, () => 's') }],
    ['long step', { steps: ['x'.repeat(5001)] }],
    ['long ingredient name', { ingredients: [{ quantity: 1, unit: 'g', name: 'x'.repeat(5001), scalable: true }] }],
    ['bad servings', { servings: 0 }],
    ['ingredients not array', { ingredients: 'flour' }],
    ['foreign imageKey', { imageKey: 'other/abc' }],
  ])('400 on %s', async (_n, over) => {
    expect((await call('POST', '/recipes', 'u1', draft(over))).status).toBe(400);
  });

  it('400 on missing body', async () => {
    expect((await call('POST', '/recipes', 'u1')).status).toBe(400);
  });

  it('accepts limits and own imageKey', async () => {
    const res = await call('POST', '/recipes', 'u1', draft({ title: 'x'.repeat(200), imageKey: 'u1/abc' }));
    expect(res.status).toBe(201);
  });
});

describe('update', () => {
  it('stores version+1, recomputes metric, keeps createdAt', async () => {
    const r = await create();
    const body = {
      ...r,
      title: 'Better',
      ingredients: [{ id: 'i1', quantity: 1, unit: 'tbsp', name: 'oil', scalable: true, metric: { quantity: 1, unit: 'kg' } }],
    };
    const res = await call('PUT', `/recipes/${r.id}`, 'u1', body);
    expect(res.status).toBe(200);
    expect(res.json.version).toBe(2);
    expect(res.json.title).toBe('Better');
    expect(res.json.createdAt).toBe(r.createdAt);
    expect(res.json.ingredients[0].metric).toEqual({ quantity: 15, unit: 'ml' });
    expect((await call('GET', `/recipes/${r.id}`, 'u1')).json.version).toBe(2);
  });

  it('stale PUT -> 409 version_conflict', async () => {
    const r = await create();
    expect((await call('PUT', `/recipes/${r.id}`, 'u1', r)).status).toBe(200);
    const stale = await call('PUT', `/recipes/${r.id}`, 'u1', r);
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ error: 'version_conflict' });
  });

  it('400 without a version, 404 for unknown id, 400 on invalid body', async () => {
    const r = await create();
    const { version: _v, ...noVersion } = r;
    void _v;
    expect((await call('PUT', `/recipes/${r.id}`, 'u1', noVersion)).status).toBe(400);
    expect((await call('PUT', '/recipes/nope', 'u1', r)).status).toBe(404);
    expect((await call('PUT', `/recipes/${r.id}`, 'u1', { ...r, title: '' })).status).toBe(400);
  });
});

describe('owner isolation', () => {
  it('another owner gets 404 for read, update, delete, restore and does not list it', async () => {
    const r = await create('u1');
    expect((await call('GET', `/recipes/${r.id}`, 'u2')).status).toBe(404);
    expect((await call('PUT', `/recipes/${r.id}`, 'u2', r)).status).toBe(404);
    expect((await call('DELETE', `/recipes/${r.id}`, 'u2')).status).toBe(404);
    expect((await call('POST', `/recipes/${r.id}/restore`, 'u2')).status).toBe(404);
    expect((await call('GET', '/recipes', 'u2')).json).toEqual([]);
    expect((await call('GET', `/recipes/${r.id}`, 'u1')).status).toBe(200);
  });
});

describe('soft delete and restore', () => {
  it('delete hides from list and GET, sets ttl ~30 days; restore brings it back', async () => {
    const r = await create();
    const before = Math.floor(Date.now() / 1000);
    const del = await call('DELETE', `/recipes/${r.id}`, 'u1');
    expect(del.status).toBe(204);
    expect(del.json).toBeUndefined();
    const stored = [...db.items.values()][0]!;
    expect(stored.deletedAt).toBeTruthy();
    expect(stored.ttl as number).toBeGreaterThanOrEqual(before + 30 * 86400);
    expect(stored.ttl as number).toBeLessThanOrEqual(before + 30 * 86400 + 5);
    expect((await call('GET', `/recipes/${r.id}`, 'u1')).status).toBe(404);
    expect((await call('GET', '/recipes', 'u1')).json).toEqual([]);
    expect((await call('PUT', `/recipes/${r.id}`, 'u1', r)).status).toBe(404);
    expect((await call('DELETE', `/recipes/${r.id}`, 'u1')).status).toBe(404);

    const res = await call('POST', `/recipes/${r.id}/restore`, 'u1');
    expect(res.status).toBe(200);
    expect(res.json.deletedAt).toBeUndefined();
    expect(res.json.version).toBe(r.version + 1);
    expect([...db.items.values()][0]!.ttl).toBeUndefined();
    expect((await call('GET', `/recipes/${r.id}`, 'u1')).status).toBe(200);
    expect((await call('GET', '/recipes', 'u1')).json).toHaveLength(1);
  });

  it('restore after the 30 days (expired ttl) is 404; restoring a live recipe is 404', async () => {
    const r = await create();
    expect((await call('POST', `/recipes/${r.id}/restore`, 'u1')).status).toBe(404);
    await call('DELETE', `/recipes/${r.id}`, 'u1');
    const item = [...db.items.values()][0]!;
    item.ttl = Math.floor(Date.now() / 1000) - 10;
    expect((await call('POST', `/recipes/${r.id}/restore`, 'u1')).status).toBe(404);
  });
});

describe('list and search', () => {
  it('returns summaries only, newest first', async () => {
    const a = await create('u1', { title: 'A', imageKey: 'u1/img' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await create('u1', { title: 'B' });
    const res = await call('GET', '/recipes', 'u1');
    expect(res.status).toBe(200);
    expect(res.json.map((s: { id: string }) => s.id)).toEqual([b.id, a.id]);
    expect(Object.keys(res.json[1]).sort()).toEqual(['id', 'imageKey', 'servings', 'tags', 'title', 'updatedAt']);
  });

  it('q matches title and ingredient names case-insensitively', async () => {
    await create('u1', { title: 'Soup', ingredients: [{ id: 'a', quantity: 1, unit: 'piece', name: 'Carrot', scalable: true }] });
    await create('u1', { title: 'CAKE' });
    const titles = async (q: string) =>
      (await call('GET', '/recipes', 'u1', undefined, `q=${q}`)).json.map((s: { title: string }) => s.title);
    expect(await titles('carrot')).toEqual(['Soup']);
    expect(await titles('cak')).toEqual(['CAKE']);
    expect(await titles('flour')).toEqual(['CAKE']);
    expect(await titles('zzz')).toEqual([]);
  });

  it('tag is an exact match', async () => {
    await create('u1', { title: 'A', tags: ['dinner'] });
    await create('u1', { title: 'B', tags: ['dinner-party'] });
    const res = await call('GET', '/recipes', 'u1', undefined, 'tag=dinner');
    expect(res.json.map((s: { title: string }) => s.title)).toEqual(['A']);
  });
});

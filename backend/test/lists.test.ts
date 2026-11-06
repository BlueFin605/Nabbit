import { beforeEach, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, resetRoutes } from '../src/router.js';
import { registerListRoutes } from '../src/routes/lists.js';
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
  const res = (await handler(event(method, path, sub, body, query))) as { statusCode: number; body?: string };
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
};

let db: ReturnType<typeof createMemoryDb>;
beforeEach(() => {
  db = createMemoryDb();
  setDb(db);
  resetRoutes();
  registerListRoutes();
});

const mk = async (sub = 'u1', name = 'Weekly') => (await call('POST', '/lists', sub, { name })).json;
const add = (id: string, body: unknown, sub = 'u1') => call('POST', `/lists/${id}/items`, sub, body);
const mem = (owner: string, name: string) => db.items.get(`OWNER#${owner}\u0000MEM#${name}`);

describe('lists CRUD', () => {
  it('creates, gets, lists and deletes', async () => {
    const res = await call('POST', '/lists', 'u1', { name: 'Weekly' });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ name: 'Weekly', items: [], version: 1 });
    expect((await call('GET', `/lists/${res.json.id}`, 'u1')).json.name).toBe('Weekly');
    const all = await call('GET', '/lists', 'u1');
    expect(all.json).toHaveLength(1);
    expect(all.json[0]).toMatchObject({ id: res.json.id, name: 'Weekly' });
    expect((await call('DELETE', `/lists/${res.json.id}`, 'u1')).status).toBe(204);
    expect((await call('GET', `/lists/${res.json.id}`, 'u1')).status).toBe(404);
  });
  it('rejects bad names', async () => {
    expect((await call('POST', '/lists', 'u1', {})).status).toBe(400);
    expect((await call('POST', '/lists', 'u1', { name: '  ' })).status).toBe(400);
    expect((await call('POST', '/lists', 'u1', { name: 'x'.repeat(101) })).status).toBe(400);
  });
  it('PUT replaces and bumps version; stale is 409', async () => {
    const l = await mk();
    const put = await call('PUT', `/lists/${l.id}`, 'u1', {
      name: 'Renamed',
      version: 1,
      items: [{ id: 'a', name: 'Milk', category: 'Dairy', checked: true }],
    });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ name: 'Renamed', version: 2 });
    expect(put.json.items[0]).toMatchObject({ id: 'a', name: 'Milk', checked: true });
    const stale = await call('PUT', `/lists/${l.id}`, 'u1', { name: 'X', version: 1, items: [] });
    expect(stale.status).toBe(409);
    expect((await call('PUT', `/lists/${l.id}`, 'u1', { name: 'X', items: [] })).status).toBe(400);
  });
  it('PUT rejects more than 500 items', async () => {
    const l = await mk();
    const items = Array.from({ length: 501 }, (_, i) => ({ id: `i${i}`, name: `n${i}`, category: 'Other', checked: false }));
    expect((await call('PUT', `/lists/${l.id}`, 'u1', { name: 'X', version: 1, items })).status).toBe(400);
  });
  it('enforces the 50 list limit', async () => {
    for (let i = 0; i < 50; i++) expect((await call('POST', '/lists', 'u1', { name: `L${i}` })).status).toBe(201);
    expect((await call('POST', '/lists', 'u1', { name: 'one more' })).status).toBe(400);
    expect((await call('POST', '/lists', 'u2', { name: 'other owner ok' })).status).toBe(201);
  });
});

describe('adding items', () => {
  it('defaults category to Other and bumps version', async () => {
    const l = await mk();
    const res = await add(l.id, { name: 'Widgets' });
    expect(res.status).toBe(201);
    expect(res.json.version).toBe(2);
    expect(res.json.items[0]).toMatchObject({ name: 'Widgets', category: 'Other', checked: false });
  });
  it('uses remembered category after a categorised add', async () => {
    const l = await mk();
    await add(l.id, { name: 'Milk', category: 'Dairy' });
    const l2 = await mk('u1', 'Second');
    const res = await add(l2.id, { name: 'milk' });
    expect(res.json.items[0].category).toBe('Dairy');
    expect(mem('u1', 'milk')).toMatchObject({ category: 'Dairy', uses: 2 });
  });
  it('merges onto an unchecked duplicate', async () => {
    const l = await mk();
    await add(l.id, { name: 'Eggs' });
    const res = await add(l.id, { name: 'EGGS' });
    expect(res.json.items).toHaveLength(1);
  });
  it('checked duplicate creates a new item', async () => {
    const l = await mk();
    const a = await add(l.id, { name: 'Eggs' });
    await call('PATCH', `/lists/${l.id}/items/${a.json.items[0].id}`, 'u1', { checked: true });
    const res = await add(l.id, { name: 'Eggs' });
    expect(res.json.items).toHaveLength(2);
  });
  it('accepts a batch, merging within the batch', async () => {
    const l = await mk();
    const res = await add(l.id, { items: [{ name: 'A' }, { name: 'B', category: 'Pantry' }, { name: 'a' }] });
    expect(res.status).toBe(201);
    expect(res.json.items.map((i: { name: string }) => i.name)).toEqual(['A', 'B']);
    expect(res.json.version).toBe(2);
  });
  it('validates', async () => {
    const l = await mk();
    expect((await add(l.id, {})).status).toBe(400);
    expect((await add(l.id, { name: '' })).status).toBe(400);
    expect((await add(l.id, { name: 'x'.repeat(101) })).status).toBe(400);
    expect((await add(l.id, { name: 'a', category: 5 })).status).toBe(400);
    expect((await add(l.id, { items: [{ name: 'ok' }, { name: '' }] })).status).toBe(400);
  });
  it('enforces 500 items per list', async () => {
    const l = await mk();
    const items = Array.from({ length: 500 }, (_, i) => ({ name: `item${i}` }));
    expect((await add(l.id, { items })).status).toBe(201);
    expect((await add(l.id, { name: 'overflow' })).status).toBe(400);
  });
});

describe('patch and delete item', () => {
  it('toggles checked, renames and recategorises (updating memory)', async () => {
    const l = await mk();
    const a = await add(l.id, { name: 'Bread' });
    const itemId = a.json.items[0].id;
    const p = await call('PATCH', `/lists/${l.id}/items/${itemId}`, 'u1', { checked: true, category: 'Bakery' });
    expect(p.status).toBe(200);
    expect(p.json.items[0]).toMatchObject({ checked: true, category: 'Bakery' });
    expect(p.json.version).toBe(3);
    expect(mem('u1', 'bread')).toMatchObject({ category: 'Bakery' });
    const r = await call('PATCH', `/lists/${l.id}/items/${itemId}`, 'u1', { name: 'Rolls' });
    expect(r.json.items[0].name).toBe('Rolls');
  });
  it('400 on bad patch, 404 on unknown item', async () => {
    const l = await mk();
    const a = await add(l.id, { name: 'Bread' });
    expect((await call('PATCH', `/lists/${l.id}/items/${a.json.items[0].id}`, 'u1', { checked: 'yes' })).status).toBe(400);
    expect((await call('PATCH', `/lists/${l.id}/items/nope`, 'u1', { checked: true })).status).toBe(404);
    expect((await call('DELETE', `/lists/${l.id}/items/nope`, 'u1')).status).toBe(404);
  });
  it('deletes an item', async () => {
    const l = await mk();
    const a = await add(l.id, { name: 'Bread' });
    const d = await call('DELETE', `/lists/${l.id}/items/${a.json.items[0].id}`, 'u1');
    expect(d.status).toBe(200);
    expect(d.json.items).toEqual([]);
  });
});

describe('suggest', () => {
  it('returns prefix matches ordered by uses desc with categories', async () => {
    const l = await mk();
    await add(l.id, { items: [{ name: 'Apple', category: 'Produce' }, { name: 'Avocado', category: 'Produce' }, { name: 'Bread' }] });
    const l2 = await mk('u1', 'Two');
    await add(l2.id, { name: 'Avocado' });
    const res = await call('GET', '/items/suggest', 'u1', undefined, 'q=A');
    expect(res.status).toBe(200);
    expect(res.json).toEqual([
      { name: 'avocado', category: 'Produce' },
      { name: 'apple', category: 'Produce' },
    ]);
  });
  it('caps at 8 and is owner scoped', async () => {
    const l = await mk();
    await add(l.id, { items: Array.from({ length: 12 }, (_, i) => ({ name: `tom${i}` })) });
    expect((await call('GET', '/items/suggest', 'u1', undefined, 'q=tom')).json).toHaveLength(8);
    expect((await call('GET', '/items/suggest', 'u2', undefined, 'q=tom')).json).toEqual([]);
  });
});

describe('cross-owner isolation', () => {
  it('every list route is 404 for another owner', async () => {
    const l = await mk('u1');
    const a = await add(l.id, { name: 'Milk' });
    const itemId = a.json.items[0].id;
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `/lists/${l.id}`],
      ['PUT', `/lists/${l.id}`, { name: 'x', version: 2, items: [] }],
      ['DELETE', `/lists/${l.id}`],
      ['POST', `/lists/${l.id}/items`, { name: 'x' }],
      ['PATCH', `/lists/${l.id}/items/${itemId}`, { checked: true }],
      ['DELETE', `/lists/${l.id}/items/${itemId}`],
    ];
    for (const [m, p, b] of calls) expect((await call(m, p, 'u2', b)).status, `${m} ${p}`).toBe(404);
    expect((await call('GET', '/lists', 'u2')).json).toEqual([]);
    expect((await call('GET', `/lists/${l.id}`, 'u1')).json.items).toHaveLength(1);
  });
});

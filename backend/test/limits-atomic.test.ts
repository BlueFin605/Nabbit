import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, resetRoutes } from '../src/router.js';
import { registerRecipeRoutes } from '../src/routes/recipes.js';
import { registerListRoutes } from '../src/routes/lists.js';
import { createDynamoDb, setDb } from '../src/db.js';
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
  registerRecipeRoutes();
  registerListRoutes();
});

const recipe = (extra: Record<string, unknown> = {}) => ({
  title: 'T',
  servings: 2,
  ingredients: [],
  steps: [],
  tags: [],
  ...extra,
});

describe('size caps', () => {
  it('rejects an oversize recipe with 400 too_large', async () => {
    const big = 'x'.repeat(5000);
    const ingredients = Array.from({ length: 200 }, () => ({ name: big, quantity: 1, original: big, note: big }));
    const res = await call('POST', '/recipes', 'u1', recipe({ ingredients }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'too_large' });
  });

  it('rejects an oversize list replace with 400 too_large', async () => {
    const list = (await call('POST', '/lists', 'u1', { name: 'L' })).json;
    const nm = '€'.repeat(100); // 3 bytes each in UTF-8
    const items = Array.from({ length: 500 }, (_, i) => ({ id: `${'i'.repeat(90)}${i}`, name: nm, category: nm }));
    const res = await call('PUT', `/lists/${list.id}`, 'u1', { name: 'L', items, version: 1 });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'too_large' });
  });

  it('rejects an over-long suggest query with 400', async () => {
    expect((await call('GET', '/items/suggest', 'u1', undefined, `q=${'a'.repeat(101)}`)).status).toBe(400);
  });
});

describe('path ids', () => {
  it('404s an over-long id on every id route', async () => {
    const long = 'a'.repeat(2000);
    expect((await call('GET', `/recipes/${long}`, 'u1')).status).toBe(404);
    expect((await call('DELETE', `/recipes/${long}`, 'u1')).status).toBe(404);
    expect((await call('GET', `/lists/${long}`, 'u1')).status).toBe(404);
    expect((await call('PATCH', `/lists/abc/items/${long}`, 'u1', { checked: true })).status).toBe(404);
  });

  it('treats ids with # or / as plain unknown ids and never crosses owner partitions', async () => {
    const created = (await call('POST', '/recipes', 'victim', recipe())).json;
    expect((await call('GET', '/recipes/x%23y', 'attacker')).status).toBe(404);
    expect((await call('GET', '/recipes/x%2Fy', 'attacker')).status).toBe(404);
    expect((await call('GET', `/recipes/${created.id}%23z`, 'victim')).status).toBe(404);
    expect((await call('GET', `/recipes/${created.id}`, 'attacker')).status).toBe(404);
    expect((await call('GET', `/recipes/${created.id}`, 'victim')).status).toBe(200);
  });
});

describe('atomic item memory', () => {
  it('counts every concurrent add of the same item', async () => {
    const N = 20;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push((await call('POST', '/lists', 'u1', { name: `L${i}` })).json.id);
    const res = await Promise.all(ids.map((id) => call('POST', `/lists/${id}/items`, 'u1', { name: 'Milk', category: 'Dairy' })));
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(db.items.get('OWNER#u1\u0000MEM#milk')).toMatchObject({ uses: N, category: 'Dairy' });
  });

  it('a category patch updates category without inflating uses', async () => {
    const list = (await call('POST', '/lists', 'u1', { name: 'L' })).json;
    const added = (await call('POST', `/lists/${list.id}/items`, 'u1', { name: 'Milk' })).json;
    await call('PATCH', `/lists/${list.id}/items/${added.items[0].id}`, 'u1', { category: 'Dairy' });
    expect(db.items.get('OWNER#u1\u0000MEM#milk')).toMatchObject({ uses: 1, category: 'Dairy' });
  });
});

describe('Db.bumpItemMemory', () => {
  it('in-memory: creates at by, accumulates, sets category/updatedAt, keeps other attributes', async () => {
    await db.bumpItemMemory('OWNER#a', 'MEM#x', 'Other', 't1', 1);
    expect(await db.getItem('OWNER#a', 'MEM#x')).toEqual({ pk: 'OWNER#a', sk: 'MEM#x', uses: 1, category: 'Other', updatedAt: 't1' });
    await db.putItem({ pk: 'OWNER#a', sk: 'MEM#y', uses: 5, category: 'A', extra: 'keep' });
    await db.bumpItemMemory('OWNER#a', 'MEM#y', 'B', 't2', 2);
    expect(await db.getItem('OWNER#a', 'MEM#y')).toMatchObject({ uses: 7, category: 'B', updatedAt: 't2', extra: 'keep' });
  });

  it('DynamoDB: sends one UpdateCommand with ADD uses and SET category/updatedAt', async () => {
    const send = vi.fn().mockResolvedValue({});
    const real = createDynamoDb('tbl', { send } as never);
    await real.bumpItemMemory('OWNER#a', 'MEM#milk', 'Dairy', '2026-01-01T00:00:00.000Z', 1);
    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0].input;
    expect(input).toEqual({
      TableName: 'tbl',
      Key: { pk: 'OWNER#a', sk: 'MEM#milk' },
      UpdateExpression: 'ADD #u :by SET #c = :c, #t = :t',
      ExpressionAttributeNames: { '#u': 'uses', '#c': 'category', '#t': 'updatedAt' },
      ExpressionAttributeValues: { ':by': 1, ':c': 'Dairy', ':t': '2026-01-01T00:00:00.000Z' },
    });
  });
});

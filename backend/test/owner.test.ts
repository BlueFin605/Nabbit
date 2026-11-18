import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, resetRoutes, route } from '../src/router.js';
import { setDb, type Db } from '../src/db.js';
import { createMemoryDb } from '../src/db-memory.js';
import { resolveOwner, resetOwnerCache } from '../src/owner.js';
import { registerImportRoutes, setImportDeps } from '../src/routes/import.js';

function event(path: string, sub: string, method = 'GET', body?: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method, path }, authorizer: { jwt: { claims: { sub }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  resetOwnerCache();
  resetRoutes();
  setImportDeps(undefined);
});

describe('resolveOwner', () => {
  it('returns legacySub when an alias item exists', async () => {
    const db = createMemoryDb();
    await db.putItem({ pk: 'ALIAS#new-sub', sk: 'ALIAS', legacySub: 'old-sub' });
    expect(await resolveOwner(db, 'new-sub')).toBe('old-sub');
  });

  it('returns the sub itself when there is no alias', async () => {
    expect(await resolveOwner(createMemoryDb(), 'plain')).toBe('plain');
  });

  it('caches hits and misses so getItem runs once per sub', async () => {
    const db = createMemoryDb();
    await db.putItem({ pk: 'ALIAS#a', sk: 'ALIAS', legacySub: 'legacy-a' });
    const spy = vi.spyOn(db, 'getItem');
    await resolveOwner(db, 'a');
    await resolveOwner(db, 'a');
    await resolveOwner(db, 'b');
    await resolveOwner(db, 'b');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('router uses the resolved owner', () => {
  it('passes the alias legacySub as ownerId to route handlers', async () => {
    const db: Db = createMemoryDb();
    await db.putItem({ pk: 'ALIAS#new-sub', sk: 'ALIAS', legacySub: 'old-sub' });
    setDb(db);
    route('GET', '/whoami', async (ctx) => ({ status: 200, body: { ownerId: ctx.ownerId } }));
    const res = (await handler(event('/whoami', 'new-sub'))) as { body: string };
    expect(JSON.parse(res.body)).toEqual({ ownerId: 'old-sub' });
    const res2 = (await handler(event('/whoami', 'other'))) as { body: string };
    expect(JSON.parse(res2.body)).toEqual({ ownerId: 'other' });
  });

  it('import route counts its rate limit under the resolved owner', async () => {
    const db = createMemoryDb();
    await db.putItem({ pk: 'ALIAS#new-sub', sk: 'ALIAS', legacySub: 'old-sub' });
    setDb(db);
    registerImportRoutes();
    await handler(event('/recipes/import', 'new-sub', 'POST', { url: 'https://127.0.0.1/' }));
    const rate = await db.queryItems('OWNER#old-sub', 'RATE#import#');
    expect(rate.length).toBe(1);
    expect(await db.queryItems('OWNER#new-sub', 'RATE#')).toEqual([]);
  });
});

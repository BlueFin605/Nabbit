import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { HttpError, handler, resetRoutes, route } from '../src/router.js';

function event(method: string, path: string, opts: { sub?: string; body?: string; b64?: boolean; query?: string } = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: opts.query ?? '',
    headers: {},
    body: opts.body,
    isBase64Encoded: opts.b64 ?? false,
    requestContext: {
      http: { method, path },
      ...(opts.sub ? { authorizer: { jwt: { claims: { sub: opts.sub }, scopes: [] } } } : {}),
    },
  } as unknown as APIGatewayProxyEventV2;
}

const call = async (e: APIGatewayProxyEventV2) => {
  const res = (await handler(e, {} as never, () => undefined)) as { statusCode: number; headers: Record<string, string>; body?: string };
  return { ...res, json: res.body ? JSON.parse(res.body) : undefined };
};

describe('router', () => {
  beforeEach(() => resetRoutes());

  it('401 without a sub claim', async () => {
    route('GET', '/recipes', async () => ({ status: 200 }));
    const res = await call(event('GET', '/recipes'));
    expect(res.statusCode).toBe(401);
    expect(res.json).toEqual({ error: 'unauthorized' });
  });

  it('404 for unknown route', async () => {
    const res = await call(event('GET', '/nope', { sub: 'u1' }));
    expect(res.statusCode).toBe(404);
    expect(res.json).toEqual({ error: 'not_found' });
    expect(res.headers['content-type']).toBe('application/json');
  });

  it('404 when method differs', async () => {
    route('GET', '/recipes', async () => ({ status: 200 }));
    expect((await call(event('POST', '/recipes', { sub: 'u1' }))).statusCode).toBe(404);
  });

  it('extracts params, query and JSON body', async () => {
    const h = vi.fn(async () => ({ status: 201, body: { ok: true } }));
    route('POST', '/recipes/{id}/notes/{noteId}', h);
    const res = await call(event('POST', '/recipes/a%20b/notes/7', { sub: 'u1', query: 'q=1&x=y', body: '{"a":1}' }));
    expect(res.statusCode).toBe(201);
    expect(res.json).toEqual({ ok: true });
    expect(h).toHaveBeenCalledWith({ ownerId: 'u1', params: { id: 'a b', noteId: '7' }, query: { q: '1', x: 'y' }, body: { a: 1 } });
  });

  it('decodes base64 bodies and tolerates empty body', async () => {
    const h = vi.fn(async () => ({ status: 204 }));
    route('PUT', '/x', h);
    await call(event('PUT', '/x', { sub: 'u1', body: Buffer.from('{"b":2}').toString('base64'), b64: true }));
    expect(h.mock.calls[0]![0].body).toEqual({ b: 2 });
    const res = await call(event('PUT', '/x', { sub: 'u1' }));
    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
    expect(h.mock.calls[1]![0].body).toBeUndefined();
  });

  it('400 on malformed JSON', async () => {
    route('POST', '/x', async () => ({ status: 200 }));
    const res = await call(event('POST', '/x', { sub: 'u1', body: '{nope' }));
    expect(res.statusCode).toBe(400);
    expect(res.json).toEqual({ error: 'invalid_json' });
  });

  it('maps HttpError to its status', async () => {
    route('GET', '/x', async () => {
      throw new HttpError(409, 'conflict_here');
    });
    const res = await call(event('GET', '/x', { sub: 'u1' }));
    expect(res.statusCode).toBe(409);
    expect(res.json).toEqual({ error: 'conflict_here' });
  });

  it('500 hides internals and logs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    route('GET', '/x', async () => {
      throw new Error('secret db password');
    });
    const res = await call(event('GET', '/x', { sub: 'u1' }));
    expect(res.statusCode).toBe(500);
    expect(res.json).toEqual({ error: 'internal' });
    expect(res.body).not.toContain('secret');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('ownerId is always the claim, never the body', async () => {
    const h = vi.fn(async () => ({ status: 200 }));
    route('POST', '/x', h);
    await call(event('POST', '/x', { sub: 'real', body: '{"ownerId":"attacker"}' }));
    expect(h.mock.calls[0]![0].ownerId).toBe('real');
  });

  it('rejects duplicate registration', () => {
    route('GET', '/dup', async () => ({ status: 200 }));
    expect(() => route('GET', '/dup', async () => ({ status: 200 }))).toThrow();
  });
});

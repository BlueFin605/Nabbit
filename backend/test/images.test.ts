import { beforeEach, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, resetRoutes } from '../src/router.js';
import { registerRecipeRoutes } from '../src/routes/recipes.js';
import { registerImageRoutes, setImageSigner, type SignRequest } from '../src/routes/images.js';
import { setDb } from '../src/db.js';
import { createMemoryDb } from '../src/db-memory.js';

function event(method: string, path: string, sub: string, body?: unknown): APIGatewayProxyEventV2 {
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
const call = async (method: string, path: string, sub: string, body?: unknown) => {
  const res = (await handler(event(method, path, sub, body))) as { statusCode: number; body?: string };
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
};

let signed: SignRequest[];
beforeEach(() => {
  resetRoutes();
  registerImageRoutes();
  registerRecipeRoutes();
  setDb(createMemoryDb());
  signed = [];
  setImageSigner(async (req) => {
    signed.push(req);
    return { url: 'https://bucket.s3.example/', fields: { key: req.key, 'Content-Type': req.contentType } };
  });
});

describe('POST /recipes/images', () => {
  it('returns a presigned POST whose key is prefixed with the JWT sub', async () => {
    const r = await call('POST', '/recipes/images', 'user-1', { contentType: 'image/png' });
    expect(r.status).toBe(200);
    expect(r.json.imageKey).toMatch(/^user-1\/[0-9a-f-]{36}\.png$/);
    expect(r.json.url).toBe('https://bucket.s3.example/');
    expect(r.json.fields.key).toBe(r.json.imageKey);
    expect(signed[0]).toMatchObject({ key: r.json.imageKey, contentType: 'image/png', maxBytes: 5 * 1024 * 1024 });
  });

  it('maps content types to extensions', async () => {
    for (const [ct, ext] of [['image/jpeg', 'jpg'], ['image/webp', 'webp']] as const) {
      const r = await call('POST', '/recipes/images', 'u', { contentType: ct });
      expect(r.status).toBe(200);
      expect(r.json.imageKey.endsWith(`.${ext}`)).toBe(true);
    }
  });

  it('expires in at most 300 seconds', async () => {
    const r = await call('POST', '/recipes/images', 'u', { contentType: 'image/webp' });
    expect(r.json.expiresIn).toBeLessThanOrEqual(300);
    expect(signed[0]!.expiresIn).toBeLessThanOrEqual(300);
  });

  it('ignores a client-supplied owner/key', async () => {
    const r = await call('POST', '/recipes/images', 'u', { contentType: 'image/png', ownerId: 'evil', key: 'evil/x.png' });
    expect(r.json.imageKey.startsWith('u/')).toBe(true);
  });

  it.each([{ contentType: 'image/gif' }, { contentType: 'text/html' }, { contentType: 5 }, {}])('rejects %j with 400', async (b) => {
    expect((await call('POST', '/recipes/images', 'u', b)).status).toBe(400);
  });

  it('rejects a missing body with 400', async () => {
    expect((await call('POST', '/recipes/images', 'u')).status).toBe(400);
  });
});

describe('recipe save with imageKey', () => {
  const recipe = (imageKey: string) => ({ title: 'T', servings: 1, ingredients: [], steps: [], tags: [], imageKey });
  it('rejects a foreign imageKey with 400', async () => {
    expect((await call('POST', '/recipes', 'u1', recipe('u2/abc.png'))).status).toBe(400);
  });
  it('accepts own imageKey', async () => {
    expect((await call('POST', '/recipes', 'u1', recipe('u1/abc.png'))).status).toBe(201);
  });
  it('rejects a prefix-lookalike owner', async () => {
    expect((await call('POST', '/recipes', 'u1', recipe('u10/abc.png'))).status).toBe(400);
  });
});

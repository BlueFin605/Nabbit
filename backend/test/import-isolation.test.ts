import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

function event(rawPath: string, method = 'POST', body: unknown = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath,
    rawQueryString: '',
    headers: {},
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method, path: rawPath }, authorizer: { jwt: { claims: { sub: 'u1' }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2;
}
type H = (e: APIGatewayProxyEventV2) => Promise<{ statusCode?: number }>;

beforeEach(() => vi.resetModules());

describe('import route isolation', () => {
  it('api handler does not serve POST /recipes/import or path variants', async () => {
    const { handler } = (await import('../src/handlers/api.js')) as { handler: H };
    for (const p of ['/recipes/import', '/recipes//import', '/recipes/import/']) {
      expect((await handler(event(p))).statusCode, p).toBe(404);
    }
  });

  it('import handler serves POST /recipes/import (400 on invalid body, not 404)', async () => {
    const { handler } = (await import('../src/handlers/import.js')) as { handler: H };
    expect((await handler(event('/recipes/import'))).statusCode).toBe(400);
  });

  it('router rejects paths with empty segments', async () => {
    const { handler } = (await import('../src/handlers/import.js')) as { handler: H };
    for (const p of ['/recipes//import', '/recipes/import/', '//recipes/import']) {
      expect((await handler(event(p))).statusCode, p).toBe(404);
    }
  });

  it('local app still serves the import route', async () => {
    const { start } = await import('../src/local.js');
    const server = await start(0);
    try {
      const port = (server.address() as { port: number }).port;
      const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')}.y`;
      const res = await fetch(`http://127.0.0.1:${port}/recipes/import`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('handlers/api.ts source does not import routes/import', () => {
    const src = readFileSync(new URL('../src/handlers/api.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\s[^\n]*routes\/import/m);
  });
});

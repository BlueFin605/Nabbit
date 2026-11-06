import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { FIXTURE_HOST, FIXTURE_IG_HOST, fixtureFetchDeps } from '../src/e2e-fixture-fetch.js';
import { installE2eFixtureFetch } from '../src/local.js';
import { handler as importHandler } from '../src/handlers/import.js';
import { resetRoutes } from '../src/router.js';
import { registerImportRoutes, setImportDeps } from '../src/routes/import.js';
import { safeFetch } from '../src/import/safe-fetch.js';
import { setDb } from '../src/db.js';
import { createMemoryDb } from '../src/db-memory.js';

const ON = { NODE_ENV: 'development', NABBIT_E2E_FIXTURE_FETCH: '1', NABBIT_E2E_FIXTURE_ORIGIN: 'http://127.0.0.1:4999' };

describe('fixtureFetchDeps gating', () => {
  it('is off by default', () => {
    expect(fixtureFetchDeps({})).toBeUndefined();
    expect(fixtureFetchDeps({ NODE_ENV: 'development' })).toBeUndefined();
  });
  it('is off in production even with the flag and origin set', () => {
    expect(fixtureFetchDeps({ ...ON, NODE_ENV: 'production' })).toBeUndefined();
  });
  it('is off without NODE_ENV even with the flag set', () => {
    expect(fixtureFetchDeps({ NABBIT_E2E_FIXTURE_FETCH: '1', NABBIT_E2E_FIXTURE_ORIGIN: ON.NABBIT_E2E_FIXTURE_ORIGIN })).toBeUndefined();
  });
  it('is off unless the flag is exactly 1', () => {
    expect(fixtureFetchDeps({ ...ON, NABBIT_E2E_FIXTURE_FETCH: 'true' })).toBeUndefined();
  });
  it('is off when the origin is missing, non-http, non-loopback or portless', () => {
    for (const origin of [undefined, '', 'https://127.0.0.1:4999', 'http://example.com:80', 'http://10.0.0.5:4999', 'http://127.0.0.1', 'nope']) {
      expect(fixtureFetchDeps({ ...ON, NABBIT_E2E_FIXTURE_ORIGIN: origin })).toBeUndefined();
    }
  });
  it('is on only with development + flag + loopback origin', () => {
    expect(fixtureFetchDeps(ON)).toBeDefined();
  });
});

describe('fixture deps are confined to the fixture host', () => {
  it('refuses to resolve or fetch any other host', async () => {
    const deps = fixtureFetchDeps(ON)!;
    await expect(deps.resolve!('example.com')).rejects.toThrow();
    await expect(deps.resolve!('localhost')).rejects.toThrow();
    await expect(deps.fetchImpl!('https://example.com/x')).rejects.toThrow();
    expect(await deps.resolve!(FIXTURE_HOST)).toHaveLength(1);
    expect(await deps.resolve!(FIXTURE_IG_HOST)).toHaveLength(1);
  });

  describe('end to end through the real guard', () => {
    let server: Server;
    beforeEach(async () => {
      server = createServer((req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(`<html><body>${req.url}</body></html>`);
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    });
    afterEach(() => new Promise<void>((r) => server.close(() => r())));

    it('serves the fixture page, while the guard still rejects loopback and http', async () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const deps = fixtureFetchDeps({ ...ON, NABBIT_E2E_FIXTURE_ORIGIN: origin })!;
      const page = await safeFetch(`https://${FIXTURE_HOST}/pasta?x=1`, deps);
      expect(page.html).toContain('/pasta?x=1');
      await expect(safeFetch('https://127.0.0.1/x', deps)).rejects.toMatchObject({ code: 'blocked_address' });
      await expect(safeFetch(`http://${FIXTURE_HOST}/x`, deps)).rejects.toMatchObject({ code: 'bad_url' });
      await expect(safeFetch(`https://${FIXTURE_HOST}:8443/x`, deps)).rejects.toMatchObject({ code: 'bad_url' });
    });
  });
});

describe('installE2eFixtureFetch (local server only)', () => {
  beforeEach(() => {
    setDb(createMemoryDb());
    setImportDeps(undefined);
  });
  afterEach(() => setImportDeps(undefined));

  it('does nothing and returns false when off', () => {
    expect(installE2eFixtureFetch({})).toBe(false);
    expect(installE2eFixtureFetch({ ...ON, NODE_ENV: 'production' })).toBe(false);
  });
  it('installs when on', () => {
    expect(installE2eFixtureFetch(ON)).toBe(true);
  });
});

describe('Lambda import handler default path', () => {
  const event = (url: string): APIGatewayProxyEventV2 =>
    ({
      version: '2.0',
      routeKey: '$default',
      rawPath: '/recipes/import',
      rawQueryString: '',
      headers: {},
      body: JSON.stringify({ url }),
      isBase64Encoded: false,
      requestContext: { http: { method: 'POST', path: '/recipes/import' }, authorizer: { jwt: { claims: { sub: 'u1' }, scopes: [] } } },
    }) as unknown as APIGatewayProxyEventV2;

  beforeEach(() => {
    setDb(createMemoryDb());
    setImportDeps(undefined);
    resetRoutes();
    registerImportRoutes();
  });

  it('still blocks loopback and private addresses with the real safeFetch', async () => {
    for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://10.0.0.1/', 'https://localhost/']) {
      const res = (await importHandler(event(url))) as { statusCode: number; body: string };
      expect(res.statusCode).toBe(422);
      expect(JSON.parse(res.body)).toEqual({ error: 'blocked_address' });
    }
  });

  it('the Lambda entry points never reference the e2e hook', () => {
    for (const f of ['handlers/import.ts', 'handlers/api.ts', 'routes/import.ts', 'import/safe-fetch.ts']) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
      expect(src).not.toMatch(/NABBIT_E2E|e2e-fixture|fixtureFetchDeps/);
    }
  });
});

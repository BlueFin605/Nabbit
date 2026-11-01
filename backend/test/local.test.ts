import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { start } from '../src/local';
import { resolveSub } from '../src/local-adapter';

let server: Server;
let base: string;

beforeAll(async () => {
  server = await start(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('local server', () => {
  it('serves GET /health through the Express adapter', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('routes other paths to the API handler', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(401);
    const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')}.y`;
    const res = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${jwt}` } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('resolveSub', () => {
  const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url')}.y`;
  it('reads sub from a bearer JWT', () => {
    expect(resolveSub({ authorization: `Bearer ${jwt}` }, {})).toBe('user-1');
  });
  it('honours X-Dev-Sub only in development', () => {
    expect(resolveSub({ 'x-dev-sub': 'dev' }, { NODE_ENV: 'development' })).toBe('dev');
    expect(resolveSub({ 'x-dev-sub': 'dev' }, { NODE_ENV: 'production' })).toBeUndefined();
  });
});

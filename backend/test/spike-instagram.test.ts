import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractCaption } from '../scripts/spike-instagram.mjs';

const run = promisify(execFile);
const LONG = 'Creamy garlic pasta. Ingredients: 200g pasta, 2 cloves garlic, 100ml cream, parmesan. Method: boil pasta, fry garlic, add cream, toss.';

const page = (desc: string) => `<html><head><meta property="og:title" content="t"><meta property="og:description" content="${desc}"></head></html>`;
const wrap = (caption: string) => `123 likes, 4 comments - chef on March 3, 2025: &quot;${caption}&quot;`;

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/good') { res.setHeader('content-type', 'text/html'); res.end(page(wrap(LONG))); }
    else if (req.url === '/trunc') { res.setHeader('content-type', 'text/html'); res.end(page(wrap(LONG + '...'))); }
    else if (req.url === '/login') { res.statusCode = 302; res.setHeader('location', '/accounts/login/?next=/login'); res.end(); }
    else if (req.url?.startsWith('/accounts/login')) { res.setHeader('content-type', 'text/html'); res.end('<html>login</html>'); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('extractCaption', () => {
  it('strips the likes/comments wrapper and unescapes entities', () => {
    expect(extractCaption(page(wrap('Tom &amp; Jerry soup')))).toBe('Tom & Jerry soup');
  });
  it('falls back to og:title and returns empty when absent', () => {
    expect(extractCaption('<meta property="og:title" content="Just a title">')).toBe('Just a title');
    expect(extractCaption('<html></html>')).toBe('');
  });
});

describe('spike-instagram script', () => {
  it('reports usable, truncated and login-redirect rows and a verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spike-'));
    const file = join(dir, 'urls.txt');
    writeFileSync(file, [`${base}/good`, `${base}/trunc`, `${base}/login`].join('\n'));
    const { stdout } = await run(process.execPath, ['scripts/spike-instagram.mjs', file], { env: { ...process.env, SPIKE_ALLOW_HTTP: '1', SPIKE_PAUSE_MS: '0' } });
    expect(stdout).toMatch(/usable 1 of 3/);
    expect(stdout).toMatch(/NO-GO/);
    expect(stdout).toContain('Creamy garlic pasta');
    expect(stdout).toMatch(/looksTruncated: true/);
    expect(stdout).toMatch(/redirectedToLogin: true/);
  });
});

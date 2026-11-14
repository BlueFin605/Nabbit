import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_URLS, extractDescriptionLinks, extractPlayerResponse, flattenCaptions, resolveUrls, selectCaptionTrack } from '../scripts/spike-youtube.mjs';

const run = promisify(execFile);

describe('extractPlayerResponse', () => {
  it('parses the balanced object, ignoring braces inside strings and trailing script', () => {
    const pr = { videoDetails: { title: 'Pasta {with} "braces"', shortDescription: 'a } b\\' }, n: [1, { x: 2 }] };
    const html = `<script>var a = {x:1};</script><script>var ytInitialPlayerResponse = ${JSON.stringify(pr)};var meta = {"y":2};</script>`;
    expect(extractPlayerResponse(html)).toEqual(pr);
  });
  it('also accepts the window[...] assignment form without a space', () => {
    expect(extractPlayerResponse('ytInitialPlayerResponse={"a":{"b":1}};')).toEqual({ a: { b: 1 } });
  });
  it('returns undefined when absent, unbalanced or invalid', () => {
    expect(extractPlayerResponse('<html></html>')).toBeUndefined();
    expect(extractPlayerResponse('ytInitialPlayerResponse = {"a":{"b":1}')).toBeUndefined();
    expect(extractPlayerResponse('ytInitialPlayerResponse = {a:1};')).toBeUndefined();
    expect(extractPlayerResponse('ytInitialPlayerResponse = null;')).toBeUndefined();
  });
});

describe('selectCaptionTrack', () => {
  const t = (languageCode: string, kind?: string) => ({ languageCode, kind, baseUrl: `https://x/${languageCode}${kind ?? ''}` });
  it('prefers manual English, then auto English, then the first track', () => {
    expect(selectCaptionTrack([t('de'), t('en', 'asr'), t('en-GB')])?.languageCode).toBe('en-GB');
    expect(selectCaptionTrack([t('de'), t('en', 'asr')])?.kind).toBe('asr');
    expect(selectCaptionTrack([t('de'), t('fr', 'asr')])?.languageCode).toBe('de');
  });
  it('returns undefined for none', () => {
    expect(selectCaptionTrack([])).toBeUndefined();
    expect(selectCaptionTrack(undefined)).toBeUndefined();
  });
});

describe('flattenCaptions', () => {
  it('flattens json3 events to plain text without timestamps', () => {
    const body = JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: 'Boil the' }, { utf8: ' pasta' }] }, { tStartMs: 10, segs: [{ utf8: '\n' }] }, { tStartMs: 20 }, { segs: [{ utf8: 'Add salt' }] }] });
    expect(flattenCaptions(body)).toBe('Boil the pasta Add salt');
  });
  it('flattens classic XML and unescapes entities', () => {
    const body = '<?xml version="1.0"?><transcript><text start="0" dur="2">Tom &amp; Jerry&#39;s</text><text start="2" dur="1">line&#10;two</text></transcript>';
    expect(flattenCaptions(body)).toBe("Tom & Jerry's line two");
  });
  it('flattens timed-text format 3 (p/s) XML', () => {
    expect(flattenCaptions('<timedtext><body><p t="0" d="5"><s>Hello</s><s t="5"> world</s></p></body></timedtext>')).toBe('Hello world');
  });
  it('returns empty for empty or malformed input', () => {
    expect(flattenCaptions('')).toBe('');
    expect(flattenCaptions('{not json')).toBe('');
  });
});

describe('extractDescriptionLinks', () => {
  it('lists unique https links with trailing punctuation trimmed', () => {
    const d = 'Recipe: https://example.com/pasta. Shop (https://shop.example.com/a?b=1&c=2), again https://example.com/pasta\nhttp://insecure.example.com and https://t.co/x!';
    expect(extractDescriptionLinks(d)).toEqual(['https://example.com/pasta', 'https://shop.example.com/a?b=1&c=2', 'https://t.co/x']);
  });
  it('returns empty when none', () => expect(extractDescriptionLinks('no links')).toEqual([]));
});

describe('spike-youtube script', () => {
  let server: Server;
  let base: string;
  const LONG = 'Boil the pasta and fry the garlic. '.repeat(10);
  const player = (b: string, cap = '/cap') => ({
    videoDetails: { title: 'Garlic Pasta', shortDescription: 'Recipe https://example.com/garlic-pasta' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr', baseUrl: `${b}${cap}` }] } },
  });
  beforeAll(async () => {
    server = createServer((req, res) => {
      const b = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (req.url === '/good') { res.setHeader('content-type', 'text/html'); res.end(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player(b))};</script>`); }
      else if (req.url === '/notrack') { res.end(`<script>var ytInitialPlayerResponse = ${JSON.stringify({ videoDetails: { title: 'T' } })};</script>`); }
      else if (req.url === '/badcap') { res.end(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player(b, '/err'))};</script>`); }
      else if (req.url === '/emptycap') { res.end(`<script>var ytInitialPlayerResponse = ${JSON.stringify(player(b, '/empty'))};</script>`); }
      else if (req.url?.startsWith('/err')) { res.statusCode = 503; res.end('x'); }
      else if (req.url?.startsWith('/empty')) { res.end('<transcript/>'); }
      else if (req.url === '/wall') { res.statusCode = 302; res.setHeader('location', '/consent'); res.end(); }
      else if (req.url === '/consent') { res.setHeader('content-type', 'text/html'); res.end('<html>consent</html>'); }
      else if (req.url?.startsWith('/cap')) {
        if (req.url.includes('fmt=json3')) { res.end(JSON.stringify({ events: [{ segs: [{ utf8: LONG }] }] })); }
        else { res.end('<transcript/>'); }
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('reports a good page, a wall, and a verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spike-yt-'));
    const file = join(dir, 'urls.txt');
    writeFileSync(file, [`${base}/good`, `${base}/good`, `${base}/wall`].join('\n'));
    const { stdout } = await run(process.execPath, ['scripts/spike-youtube.mjs', file], { env: { ...process.env, SPIKE_ALLOW_HTTP: '1', SPIKE_PAUSE_MS: '0' } });
    expect(stdout).toContain('title: Garlic Pasta');
    expect(stdout).toContain('en/asr');
    expect(stdout).toContain('https://example.com/garlic-pasta');
    expect(stdout).toMatch(/wall: true/);
    expect(stdout).toMatch(/usable 2 of 3/);
    expect(stdout).toMatch(/Verdict: GO/);
  });
  it('says NO-GO when fewer than 2 of 3 are usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spike-yt-'));
    const file = join(dir, 'urls.txt');
    writeFileSync(file, [`${base}/good`, `${base}/wall`, `${base}/404`].join('\n'));
    const { stdout } = await run(process.execPath, ['scripts/spike-youtube.mjs', file], { env: { ...process.env, SPIKE_ALLOW_HTTP: '1', SPIKE_PAUSE_MS: '0' } });
    expect(stdout).toMatch(/usable 1 of 3/);
    expect(stdout).toMatch(/Verdict: NO-GO/);
  });

  const runOn = async (urls: string[]) => {
    const file = join(mkdtempSync(join(tmpdir(), 'spike-yt-')), 'urls.txt');
    writeFileSync(file, urls.join('\n'));
    return run(process.execPath, ['scripts/spike-youtube.mjs', file], { env: { ...process.env, SPIKE_ALLOW_HTTP: '1', SPIKE_PAUSE_MS: '0' } });
  };
  it('prints the caption status for a good fetch', async () => {
    const { stdout } = await runOn([`${base}/good`]);
    expect(stdout).toMatch(/captionStatus: 200/);
    expect(stdout).toMatch(/captionResult: ok/);
  });
  it('distinguishes no track, fetch failed with status, and empty text', async () => {
    const { stdout } = await runOn([`${base}/notrack`, `${base}/badcap`, `${base}/emptycap`]);
    expect(stdout).toMatch(/captionResult: no track/);
    expect(stdout).toContain("captionResult: caption fetch failed (status 503)");
    expect(stdout).toMatch(/captionStatus: 503/);
    expect(stdout).toMatch(/captionResult: empty text/);
  });
  it('exits 0 with a clear message when the urls file is missing', async () => {
    const { stdout } = await run(process.execPath, ['scripts/spike-youtube.mjs', join(tmpdir(), 'does-not-exist-spike.txt')]);
    expect(stdout).toMatch(/cannot read urls file/);
  });
});

describe('resolveUrls', () => {
  it('falls back to the built-in default list including the known video', () => {
    expect(DEFAULT_URLS).toContain('https://youtu.be/yk6tQfArMvw');
    expect(DEFAULT_URLS.length).toBeGreaterThanOrEqual(3);
    expect(resolveUrls(undefined)).toEqual(DEFAULT_URLS);
  });
  it('reads and filters a given file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'spike-yt-')), 'u.txt');
    writeFileSync(file, '# c\nhttps://a.example/x\n\n');
    expect(resolveUrls(file)).toEqual(['https://a.example/x']);
  });
});

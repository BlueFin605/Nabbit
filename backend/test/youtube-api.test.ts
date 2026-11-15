import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVideoSnippet, resetYoutubeApiCache } from '../src/import/youtube-api.js';

const ok = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

afterEach(() => {
  delete process.env.YOUTUBE_API_KEY_PARAM;
  resetYoutubeApiCache();
  vi.useRealTimers();
});

describe('fetchVideoSnippet', () => {
  it('is off (no key lookup, no fetch) without YOUTUBE_API_KEY_PARAM', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchVideoSnippet('abcdEFGhij1', { fetchImpl: fetchImpl as never })).toEqual({ reason: 'off' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('GETs the videos endpoint with part=snippet, the id and the key, and returns title + description', async () => {
    const fetchImpl = vi.fn(async () => ok({ items: [{ snippet: { title: 'T', description: 'D https://x.example/r' } }] }));
    const r = await fetchVideoSnippet('abcdEFGhij1', { getKey: async () => 'KEY+1', fetchImpl: fetchImpl as never });
    expect(r.snippet).toEqual({ title: 'T', description: 'D https://x.example/r' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/youtube/v3/videos?part=snippet&id=abcdEFGhij1&key=KEY%2B1');
    expect(init.method).toBe('GET');
  });

  it.each([
    ['non-200', () => ok({}, 403), 'status'],
    ['bad JSON', () => ok('<html>'), 'bad_json'],
    ['no items', () => ok({ items: [] }), 'not_found'],
  ])('%s -> undefined with a reason', async (_n, resp, reason) => {
    const r = await fetchVideoSnippet('abcdEFGhij1', { getKey: async () => 'k', fetchImpl: (async () => resp()) as never });
    expect(r).toEqual({ reason });
  });

  it('missing key or a throwing key lookup -> no_key; a throwing fetch -> error without leaking the key', async () => {
    expect(await fetchVideoSnippet('abcdEFGhij1', { getKey: async () => undefined })).toEqual({ reason: 'no_key' });
    expect(await fetchVideoSnippet('abcdEFGhij1', { getKey: async () => { throw new Error('ssm'); } })).toEqual({ reason: 'no_key' });
    const r = await fetchVideoSnippet('abcdEFGhij1', { getKey: async () => 'SECRET', fetchImpl: (async () => { throw new Error('boom SECRET'); }) as never });
    expect(r).toEqual({ reason: 'error' });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('times out after timeoutMs', async () => {
    vi.useFakeTimers();
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as never;
    const p = fetchVideoSnippet('abcdEFGhij1', { getKey: async () => 'k', fetchImpl, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5001);
    expect(await p).toEqual({ reason: 'timeout' });
  });
});

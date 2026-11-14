import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalYoutubeUrl, captionsToText, extractPlayerData, isYoutubeUrl, pickCaptionTrack, youtubeVideoId } from '../src/import/extract-youtube.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const ID = 'abcdEFGhij1';

describe('isYoutubeUrl', () => {
  it('accepts https youtube hosts, trailing dot and case', () => {
    for (const h of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'WWW.YouTube.com.']) {
      expect(isYoutubeUrl(`https://${h}/watch?v=${ID}`)).toBe(true);
    }
  });
  it('rejects http, other hosts and garbage', () => {
    expect(isYoutubeUrl(`http://www.youtube.com/watch?v=${ID}`)).toBe(false);
    expect(isYoutubeUrl(`https://evil.com/watch?v=${ID}`)).toBe(false);
    expect(isYoutubeUrl('https://youtube.com.evil.com/')).toBe(false);
    expect(isYoutubeUrl('not a url')).toBe(false);
  });
  it('honours e2e hosts only in development', () => {
    const url = 'https://fixture.test/watch';
    expect(isYoutubeUrl(url, { NODE_ENV: 'development', NABBIT_E2E_YOUTUBE_HOSTS: 'a.test, Fixture.test' })).toBe(true);
    expect(isYoutubeUrl(url, { NODE_ENV: 'production', NABBIT_E2E_YOUTUBE_HOSTS: 'fixture.test' })).toBe(false);
    expect(isYoutubeUrl(url, { NODE_ENV: 'development' })).toBe(false);
  });
});

describe('youtubeVideoId', () => {
  it('reads watch, youtu.be and shorts URLs', () => {
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${ID}&t=5s`)).toBe(ID);
    expect(youtubeVideoId(`https://youtu.be/${ID}?si=zzz`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
  });
  it('reads live and embed URLs', () => {
    expect(youtubeVideoId(`https://www.youtube.com/live/${ID}?si=x`)).toBe(ID);
    expect(youtubeVideoId(`https://youtube.com/embed/${ID}`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/embed/${ID}/`)).toBe(ID);
    expect(youtubeVideoId(`https://www.youtube.com/live/${ID}/extra`)).toBeUndefined();
  });
  it('rejects bad ids, wrong paths, other hosts and garbage', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=short')).toBeUndefined();
    expect(youtubeVideoId(`https://www.youtube.com/watch?v=${ID}x`)).toBeUndefined();
    expect(youtubeVideoId('https://www.youtube.com/watch')).toBeUndefined();
    expect(youtubeVideoId(`https://www.youtube.com/playlist?v=${ID}`)).toBeUndefined();
    expect(youtubeVideoId(`https://example.com/watch?v=${ID}`)).toBeUndefined();
    expect(youtubeVideoId(`http://youtu.be/${ID}`)).toBeUndefined();
    expect(youtubeVideoId('nope')).toBeUndefined();
  });
});

describe('canonicalYoutubeUrl', () => {
  it('normalises and drops extra params', () => {
    const want = `https://www.youtube.com/watch?v=${ID}`;
    expect(canonicalYoutubeUrl(`https://youtu.be/${ID}?si=a&t=3`)).toBe(want);
    expect(canonicalYoutubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PL1&t=9`)).toBe(want);
    expect(canonicalYoutubeUrl(`https://www.youtube.com/shorts/${ID}`)).toBe(want);
  });
  it('returns undefined when there is no valid id', () => {
    expect(canonicalYoutubeUrl('https://www.youtube.com/')).toBeUndefined();
    expect(canonicalYoutubeUrl('https://example.com/x')).toBeUndefined();
  });
});

describe('extractPlayerData', () => {
  it('reads title, description and caption tracks despite braces in strings', () => {
    const d = extractPlayerData(fx('youtube-watch.html'))!;
    expect(d.title).toBe('Easy Garlic Noodles');
    expect(d.description).toContain('https://example.com/garlic-noodles');
    expect(d.description).toContain('use } and { carefully "quoted"');
    expect(d.captionTracks).toHaveLength(3);
    expect(d.captionTracks[1]).toEqual({ baseUrl: expect.stringContaining('kind=asr'), languageCode: 'en', kind: 'asr' });
  });
  it('gives empty tracks when the page has none', () => {
    const d = extractPlayerData('<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"T","shortDescription":"D"}};</script>');
    expect(d).toEqual({ title: 'T', description: 'D', captionTracks: [] });
  });
  it('returns undefined without player data, with bad JSON, or for empty input', () => {
    expect(extractPlayerData('<html>consent wall</html>')).toBeUndefined();
    expect(extractPlayerData('var ytInitialPlayerResponse = {"a": ')).toBeUndefined();
    expect(extractPlayerData('var ytInitialPlayerResponse = {not json};')).toBeUndefined();
    expect(extractPlayerData('')).toBeUndefined();
  });
});

describe('pickCaptionTrack', () => {
  const t = (languageCode: string, kind?: string) => ({ baseUrl: `u-${languageCode}-${kind ?? 'm'}`, languageCode, ...(kind ? { kind } : {}) });
  it('prefers manual English, then auto English, then the first', () => {
    expect(pickCaptionTrack([t('de'), t('en', 'asr'), t('en-GB')])?.baseUrl).toBe('u-en-GB-m');
    expect(pickCaptionTrack([t('de'), t('en', 'asr')])?.baseUrl).toBe('u-en-asr');
    expect(pickCaptionTrack([t('de'), t('fr')])?.baseUrl).toBe('u-de-m');
  });
  it('returns undefined for no tracks', () => {
    expect(pickCaptionTrack([])).toBeUndefined();
  });
});

describe('captionsToText', () => {
  it('flattens json3', () => {
    expect(captionsToText(fx('youtube-captions.json3'))).toBe('Boil the noodles then add garlic and butter');
  });
  it('flattens XML, decoding entities', () => {
    expect(captionsToText(fx('youtube-captions.xml'))).toBe('Boil the noodles then add garlic & butter it\'s "easy"');
  });
  it('returns empty for bad or empty bodies', () => {
    expect(captionsToText('{broken')).toBe('');
    expect(captionsToText('')).toBe('');
    expect(captionsToText('<html></html>')).toBe('');
  });
});

describe('hardening', () => {
  const dev = { NODE_ENV: 'development', NABBIT_E2E_YOUTUBE_HOSTS: 'fixture.test' };
  it('captionsToText never throws on out-of-range numeric entities', () => {
    const xml = '<text>a &#x110000; b &#99999999; c &#xD800; d &#0; e</text>';
    expect(() => captionsToText(xml)).not.toThrow();
    expect(captionsToText(xml)).toBe('a � b � c � d � e');
  });
  it.each([
    ['unclosed <p> tags', '<p>a'],
    ['unterminated <p attributes', '<p a'],
    ['unclosed <text> with stray < in the content', '<text>a<b'],
  ])('captionsToText stays linear on a hostile 2 MB body of %s', (_, unit) => {
    const body = unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length));
    const start = performance.now();
    captionsToText(body);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
  it('captionsToText keeps nested and repeated elements in order', () => {
    expect(captionsToText('<transcript><p t="1">One <s>two</s></p><p>three</p><text>four</text></transcript>')).toBe('One two three four');
  });
  it('extractPlayerData drops caption tracks not on an https YouTube host', () => {
    const track = (u: string) => `{"baseUrl":"${u}","languageCode":"en"}`;
    const urls = ['https://evil.com/api/timedtext', 'http://www.youtube.com/api/timedtext', 'https://youtube.com@evil.com/x', 'https://www.youtube.com/api/timedtext?v=1', 'https://fixture.test/t'];
    const html = `var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[${urls.map(track).join(',')}]}}};`;
    expect(extractPlayerData(html, {})!.captionTracks.map((t) => t.baseUrl)).toEqual(['https://www.youtube.com/api/timedtext?v=1']);
    expect(extractPlayerData(html, dev)!.captionTracks.map((t) => t.baseUrl)).toEqual(['https://www.youtube.com/api/timedtext?v=1', 'https://fixture.test/t']);
  });
  it('id and canonical url honour e2e hosts and keep the host', () => {
    expect(youtubeVideoId(`https://fixture.test/watch?v=${ID}`, dev)).toBe(ID);
    expect(youtubeVideoId(`https://fixture.test/watch?v=${ID}`, {})).toBeUndefined();
    expect(canonicalYoutubeUrl(`https://fixture.test/watch?v=${ID}&t=1`, dev)).toBe(`https://fixture.test/watch?v=${ID}`);
    expect(canonicalYoutubeUrl(`https://youtu.be/${ID}`, dev)).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });
  it('tries later ytInitialPlayerResponse matches', () => {
    const html = 'if (ytInitialPlayerResponse = null) {} var ytInitialPlayerResponse = {"videoDetails":{"title":"T"}};';
    expect(extractPlayerData(html)?.title).toBe('T');
  });
  it('rejects userinfo and lookalike hosts, accepts trailing slash or si after the id', () => {
    expect(youtubeVideoId(`https://youtube.com@evil.com/watch?v=${ID}`)).toBeUndefined();
    expect(youtubeVideoId(`https://youtube.com.evil.com/watch?v=${ID}`)).toBeUndefined();
    expect(youtubeVideoId(`https://youtu.be/${ID}/`)).toBe(ID);
    expect(youtubeVideoId(`https://youtu.be/${ID}?si=abc`)).toBe(ID);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalInstagramUrl, extractInstagramCaption, INSTAGRAM_HOSTS, isInstagramUrl } from '../src/import/extract-instagram.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

describe('extractInstagramCaption', () => {
  it('strips the likes wrapper and quotes from og:description', () => {
    const c = extractInstagramCaption(fx('instagram-reel.html'))!;
    expect(c.startsWith('Garlic Butter Beans on Toast\n\nINGREDIENTS:\n- 1 can white beans')).toBe(true);
    expect(c.endsWith('3. Pile onto toast.')).toBe(true);
    expect(c).not.toMatch(/likes|&quot;/);
  });
  it('keeps emoji and collapses blank-line runs', () => {
    const c = extractInstagramCaption(fx('instagram-emoji.html'))!;
    expect(c).toContain('Lemon pasta 🍋🍝\n\nINGREDIENTS:');
    expect(c).not.toMatch(/\n{3,}/);
    expect(c.endsWith('❤️')).toBe(true);
  });
  it('returns undefined for truncated captions (... and the ellipsis char)', () => {
    expect(extractInstagramCaption(fx('instagram-truncated.html'))).toBeUndefined();
  });
  it('returns undefined for a login wall', () => {
    expect(extractInstagramCaption(fx('instagram-login-wall.html'))).toBeUndefined();
  });
  it('returns undefined when no meta is present, and for empty/short input', () => {
    expect(extractInstagramCaption(fx('instagram-no-meta.html'))).toBeUndefined();
    expect(extractInstagramCaption('')).toBeUndefined();
    expect(extractInstagramCaption('<meta property="og:description" content="1 like - a on May 1, 2024: &quot;short&quot;">')).toBeUndefined();
  });
  it('falls back to og:title, then JSON-LD', () => {
    expect(extractInstagramCaption(fx('instagram-title-only.html'))).toMatch(/^Quick tomato soup\n\nINGREDIENTS:/);
    expect(extractInstagramCaption(fx('instagram-jsonld.html'))).toMatch(/^Quick tomato soup\n\nINGREDIENTS:/);
  });
  it('falls through a truncated og:description to a usable later source', () => {
    const html = `<meta property="og:description" content="1 like - a on May 1, 2024: &quot;${'x'.repeat(50)}...">` + fx('instagram-jsonld.html');
    expect(extractInstagramCaption(html)).toMatch(/^Quick tomato soup/);
  });
  it('caps at 20,000 chars', () => {
    const html = `<meta property="og:description" content="1 like - a on May 1, 2024: &quot;${'word '.repeat(10_000)}end&quot;">`;
    expect(extractInstagramCaption(html)!.length).toBeLessThanOrEqual(20_000);
  });
});

describe('extractInstagramCaption hardening', () => {
  const body = 'Lemon pasta\n\nINGREDIENTS:\n- 200 g spaghetti\n- 1 lemon\n\nMETHOD:\n1. Boil.\n2. Toss.';
  const og = (c: string) => `<meta property="og:description" content="${c}">`;
  it('treats a generic login description as a wall even without title/og:url', () => {
    expect(extractInstagramCaption(og('Create an account or log in to Instagram - Share what you&#039;re into with the people who get you, in photos, videos and messages.'))).toBeUndefined();
    expect(extractInstagramCaption(og('Log in to Instagram to see photos and videos from your friends and discover other accounts you will love.'))).toBeUndefined();
  });
  it('treats a login-ish title alone, or an og:url on /accounts/login alone, as a wall', () => {
    const d = og(`1 like, 0 comments - a on May 1, 2024: &quot;${body}&quot;`);
    expect(extractInstagramCaption('<title>Login • Instagram</title>' + d)).toBeUndefined();
    expect(extractInstagramCaption('<meta property="og:url" content="https://www.instagram.com/accounts/login/?next=/p/x/">' + d)).toBeUndefined();
  });
  it('is linear on 80k trailing spaces then x (inside a wrapped caption)', () => {
    const t0 = Date.now();
    extractInstagramCaption(og(`1 like, 0 comments - a on May 1, 2024: &quot;${body}${' '.repeat(80_000)}x`));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('is fast on 80k spaces + x on a line of its own', () => {
    const t0 = Date.now();
    extractInstagramCaption(og(`${body}\n${' '.repeat(80_000)}x`));
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('strips a wrapper whose display name contains a colon', () => {
    const c = extractInstagramCaption(og(`12 likes, 3 comments - Chef Bob: The Cook on May 11, 2024: &quot;${body}&quot;.`))!;
    expect(c.startsWith('Lemon pasta')).toBe(true);
    expect(c.endsWith('2. Toss.')).toBe(true);
  });
  it('strips a wrapper whose display name contains a quote', () => {
    const c = extractInstagramCaption(og(`12 likes, 3 comments - Bob &quot;The Chef&quot; on May 11, 2024: &quot;${body}&quot;.`))!;
    expect(c.startsWith('Lemon pasta')).toBe(true);
  });
  it('keeps a legitimate trailing quote when no wrapper was stripped', () => {
    const cap = body + '\nAs they say: "enjoy"';
    expect(extractInstagramCaption(og(cap.replace(/"/g, '&quot;')))!.endsWith('"enjoy"')).toBe(true);
  });
});

describe('canonicalInstagramUrl', () => {
  it.each([
    ['https://www.instagram.com/p/AbC_1-x/?igsh=abc&utm_source=ig_web_copy_link#frag', 'https://www.instagram.com/p/AbC_1-x/'],
    ['https://instagram.com/reel/XyZ/?igshid=1&rpxt=2&srtk=3', 'https://www.instagram.com/reel/XyZ/'],
    ['https://www.instagram.com/reels/XyZ', 'https://www.instagram.com/reels/XyZ/'],
    ['https://m.instagram.com/tv/Q9/?x=1', 'https://www.instagram.com/tv/Q9/'],
    ['https://www.instagram.com/someone/reel/XyZ/?igsh=1', 'https://www.instagram.com/reel/XyZ/'],
    ['https://instagr.am/p/abc?utm_source=x', 'https://www.instagram.com/p/abc/'],
    ['https://www.instagram.com/someone/?hl=en#a', 'https://www.instagram.com/someone/'],
  ])('%s -> %s', (i, o) => expect(canonicalInstagramUrl(i)).toBe(o));
  it('returns garbage unchanged', () => expect(canonicalInstagramUrl('not a url')).toBe('not a url'));
});

describe('isInstagramUrl e2e host override', () => {
  const dev = { NODE_ENV: 'development', NABBIT_E2E_INSTAGRAM_HOSTS: 'ig.nabbit-fixtures.test, other.test' };
  const u = 'https://ig.nabbit-fixtures.test/instagram-post.html';
  it('counts the listed hosts as Instagram when NODE_ENV=development', () => {
    expect(isInstagramUrl(u, dev)).toBe(true);
    expect(isInstagramUrl('https://other.test/p/a', dev)).toBe(true);
    expect(isInstagramUrl('https://nabbit-fixtures.test/pasta.html', dev)).toBe(false);
    expect(isInstagramUrl('http://ig.nabbit-fixtures.test/x', dev)).toBe(false);
  });
  it('ignores the override in production, when NODE_ENV is unset, and in test', () => {
    expect(isInstagramUrl(u, { ...dev, NODE_ENV: 'production' })).toBe(false);
    expect(isInstagramUrl(u, { NABBIT_E2E_INSTAGRAM_HOSTS: dev.NABBIT_E2E_INSTAGRAM_HOSTS })).toBe(false);
    expect(isInstagramUrl(u, { ...dev, NODE_ENV: 'test' })).toBe(false);
    expect(isInstagramUrl('https://www.instagram.com/p/a/', { NODE_ENV: 'production' })).toBe(true);
  });
});

describe('isInstagramUrl', () => {
  it('includes m.instagram.com in the host list', () => expect(INSTAGRAM_HOSTS).toContain('m.instagram.com'));
  it.each(['https://instagram.com/p/a/', 'https://www.instagram.com/reel/a/', 'https://instagr.am/p/a', 'https://WWW.Instagram.com/p/x', 'https://instagram.com./p/a/', 'https://m.instagram.com/p/a/'])(
    'accepts %s',
    (u) => expect(isInstagramUrl(u)).toBe(true),
  );
  it.each(['https://notinstagram.com/r', 'https://instagram.com.evil.example/p/a', 'http://instagram.com/p/a', 'https://instagram.com@evil.com/p/a', 'https://instagram.com..evil.com/p/a', 'not a url', ''])(
    'rejects %s',
    (u) => expect(isInstagramUrl(u)).toBe(false),
  );
});

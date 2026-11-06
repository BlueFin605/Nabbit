import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractInstagramCaption, INSTAGRAM_HOSTS, isInstagramUrl } from '../src/import/extract-instagram.js';

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

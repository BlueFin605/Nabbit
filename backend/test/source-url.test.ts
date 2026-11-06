import { describe, expect, it } from 'vitest';
import { stripTrackingParams } from '../src/import/source-url.js';

describe('stripTrackingParams', () => {
  it.each([
    ['https://recipes.co.nz/recipes/the-best-lasagne/?gclid=abc&gad_source=1&gad_campaignid=2&gbraid=x&wbraid=y&fbclid=z&pp=0', 'https://recipes.co.nz/recipes/the-best-lasagne/'],
    ['https://e.com/r?utm_source=a&utm_medium=b&UTM_Campaign=c', 'https://e.com/r'],
    ['https://e.com/r?id=7&utm_source=a&page=2', 'https://e.com/r?id=7&page=2'],
    ['https://e.com/r?id=7#top', 'https://e.com/r?id=7#top'],
    ['https://e.com/r?fbclid=z#top', 'https://e.com/r#top'],
    ['https://e.com/r', 'https://e.com/r'],
  ])('%s -> %s', (i, o) => expect(stripTrackingParams(i)).toBe(o));
  it('returns garbage unchanged', () => expect(stripTrackingParams('not a url')).toBe('not a url'));
});

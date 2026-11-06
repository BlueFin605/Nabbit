import { stripTrackingParams } from './source-url';

describe('stripTrackingParams', () => {
  it('removes tracking params case-insensitively and keeps the rest', () => {
    expect(stripTrackingParams('https://e.com/r?id=7&utm_source=x&GCLID=a&fbclid=z&gad_source=1&gad_campaignid=2&gbraid=3&wbraid=4&pp=0&UTM_Medium=m#frag')).toBe(
      'https://e.com/r?id=7#frag',
    );
  });
  it('drops the ? when nothing is left', () => expect(stripTrackingParams('https://e.com/r?gclid=1')).toBe('https://e.com/r'));
  it('leaves clean and unparseable input unchanged', () => {
    expect(stripTrackingParams('https://e.com/r?id=1')).toBe('https://e.com/r?id=1');
    expect(stripTrackingParams('not a url')).toBe('not a url');
  });
});

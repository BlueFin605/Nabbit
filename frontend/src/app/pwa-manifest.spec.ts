import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Icon {
  src: string;
  sizes: string;
  purpose?: string;
}
interface Manifest {
  name: string;
  start_url: string;
  display: string;
  theme_color: string;
  icons: Icon[];
  share_target: { action: string; method: string; params: Record<string, string> };
}

const publicDir = resolve(__dirname, '../../public');
const manifest = JSON.parse(readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8')) as Manifest;

describe('manifest.webmanifest', () => {
  it('is an installable standalone app starting at /recipes', () => {
    expect(manifest.name).toBe('Nabbit');
    expect(manifest.start_url).toBe('/recipes');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBeTruthy();
  });

  it('declares the Web Share Target for /import', () => {
    expect(manifest.share_target).toEqual({
      action: '/import',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    });
  });

  it('has 192, 512 and maskable icons that exist on disk', () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) expect(existsSync(resolve(publicDir, icon.src))).toBe(true);
  });
});

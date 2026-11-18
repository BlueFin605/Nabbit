import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('scripts/help-index.mjs', () => {
  const script = resolve(__dirname, '../../../../scripts/help-index.mjs');
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'help-index-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('copies guides and writes an ordered index with titles from the first heading', () => {
    const help = join(dir, 'help');
    const assets = join(dir, 'assets');
    mkdirSync(help);
    writeFileSync(join(help, '02-scaling.md'), '# Scaling recipes\n\nbody');
    writeFileSync(join(help, '01-getting-started.md'), '# Getting started\n');
    writeFileSync(join(help, 'README.md'), '# Not a topic\n');
    execFileSync(process.execPath, [script, help, assets], { stdio: 'pipe' });
    const index = JSON.parse(readFileSync(join(assets, 'help-index.json'), 'utf8')) as unknown;
    expect(index).toEqual([
      { slug: 'getting-started', title: 'Getting started', file: '01-getting-started.md' },
      { slug: 'scaling', title: 'Scaling recipes', file: '02-scaling.md' },
    ]);
    expect(existsSync(join(assets, 'help', '02-scaling.md'))).toBe(true);
  });
});

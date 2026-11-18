// Mirrors docs/help into git-ignored src/assets/help and writes src/assets/help-index.json:
// the ordered topic list for the in-app help viewer. Source of truth is docs/help.
// Usage: node help-index.mjs [helpDir] [assetsDir]   (arguments exist for tests)
import { readdirSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helpDir = resolve(process.argv[2] ?? join(here, '..', '..', 'docs', 'help'));
const assets = resolve(process.argv[3] ?? join(here, '..', 'src', 'assets'));
const out = join(assets, 'help-index.json');

// angular.json assets cannot reach outside the workspace, so mirror docs/help into src/assets/help.
rmSync(join(assets, 'help'), { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
cpSync(helpDir, join(assets, 'help'), { recursive: true });

const titleOf = (file, fallback) => {
  const m = /^#\s+(.+?)\s*$/m.exec(readFileSync(join(helpDir, file), 'utf8'));
  return m ? m[1] : fallback;
};

const topics = readdirSync(helpDir)
  .filter((f) => /^\d\d-.+\.md$/.test(f))
  .sort()
  .map((file) => {
    const slug = file.replace(/^\d\d-/, '').replace(/\.md$/, '');
    return { slug, title: titleOf(file, slug), file };
  });
writeFileSync(out, JSON.stringify(topics, null, 2) + '\n');
console.log(`help-index: ${topics.length} topics -> ${out}`);

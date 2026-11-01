import { readdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const handlersDir = new URL('../src/handlers/', import.meta.url);
const outDir = new URL('../dist/', import.meta.url);

const names = readdirSync(handlersDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.slice(0, -'.ts'.length));

rmSync(outDir, { recursive: true, force: true });

await build({
  entryPoints: Object.fromEntries(names.map((n) => [`${n}/index`, new URL(`${n}.ts`, handlersDir).pathname.replace(/^\/([A-Za-z]:)/, '$1')])),
  outdir: outDir.pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
});

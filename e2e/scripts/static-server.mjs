// Minimal static file server: node static-server.mjs <dir> <port> [--spa]
// --spa falls back to index.html for unknown paths (Angular router). Binds 127.0.0.1 only.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const [dir, portArg, flag] = process.argv.slice(2);
const root = resolve(dir);
const spa = flag === '--spa';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
};

async function file(path) {
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const target = normalize(join(root, pathname));
  const inside = target.startsWith(root);
  let found = inside ? await file(target) : undefined;
  if (!found && inside) found = await file(join(target, 'index.html'));
  if (!found && spa) found = await file(join(root, 'index.html'));
  if (!found) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(found)] ?? 'application/octet-stream' });
  res.end(await readFile(found));
}).listen(Number(portArg), '127.0.0.1', () => console.log(`static ${root} on ${portArg}`));

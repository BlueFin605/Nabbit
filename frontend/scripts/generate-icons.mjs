#!/usr/bin/env node
// Generates simple placeholder PWA icons (green tile with a white "N") as PNGs using only node:zlib.
// Run with `npm run icons -w frontend`. Replace with real artwork whenever one exists.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BG = [0x2e, 0x7d, 0x32];
const FG = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** True when (x, y) in unit space [0,1]^2 lies on the letter N (two stems and a diagonal). */
function inN(x, y) {
  const left = 0.28;
  const right = 0.72;
  const top = 0.25;
  const bottom = 0.75;
  const stem = 0.085;
  if (y < top || y > bottom) return false;
  if (x >= left && x <= left + stem) return true;
  if (x >= right - stem && x <= right) return true;
  const t = (y - top) / (bottom - top);
  const dx = left + stem / 2 + t * (right - left - stem);
  return Math.abs(x - dx) <= stem * 0.75 && x >= left && x <= right;
}

/** `scale` shrinks the glyph toward the centre (maskable icons keep it inside the 80% safe zone). */
function png(size, scale) {
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let px = 0; px < size; px++) {
      const ux = (px + 0.5) / size;
      const uy = (py + 0.5) / size;
      const gx = (ux - 0.5) / scale + 0.5;
      const gy = (uy - 0.5) / scale + 0.5;
      const [r, g, b] = inN(gx, gy) ? FG : BG;
      row[1 + px * 3] = r;
      row[2 + px * 3] = g;
      row[3 + px * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
mkdirSync(out, { recursive: true });
const files = [
  ['pwa-192x192.png', 192, 1.15],
  ['pwa-512x512.png', 512, 1.15],
  ['maskable-icon-512x512.png', 512, 0.8],
  ['apple-touch-icon-180x180.png', 180, 1.15],
];
for (const [name, size, scale] of files) {
  writeFileSync(resolve(out, name), png(size, scale));
  console.log(`wrote ${name}`);
}

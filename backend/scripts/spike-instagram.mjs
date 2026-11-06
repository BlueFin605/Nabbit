// Spike: can we read Instagram post captions anonymously from AWS? (NAB-87, spec section 1)
// Usage (AWS CloudShell, Node 24): node spike-instagram.mjs urls.txt
// Plain GET, honest User-Agent, no cookies, no auth. Always exits 0. Zero dependencies.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const UA = 'Nabbit-spike/1.0';
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_CAPTION = 80;

function unescapeHtml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function metaContent(html, prop) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const p = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!p || p[1].toLowerCase() !== prop) continue;
    const c = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (c) return c[1] ?? c[2] ?? '';
  }
  return undefined;
}

export function hasMeta(html, prop) {
  return metaContent(html, prop) !== undefined;
}

// Caption helper: og:description (else og:title), HTML-unescaped, with the leading
// "123 likes, 4 comments - user on March 3, 2025: " wrapper and the trailing quote stripped.
export function extractCaption(html) {
  const raw = metaContent(html, 'og:description') ?? metaContent(html, 'og:title') ?? '';
  let text = unescapeHtml(raw).trim();
  text = text.replace(/^[^:"\n]{0,200}?\bon [A-Za-z]+ \d{1,2}, \d{4}:\s*["“]?/, '');
  text = text.replace(/["”]\.?\s*$/, '');
  return text.trim();
}

async function readCapped(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8');
}

async function fetchFollowing(url, allowHttp) {
  let current = url;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const u = new URL(current);
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error('only https is allowed');
    const res = await fetch(u, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html' },
      signal: globalThis.AbortSignal.timeout(TIMEOUT_MS),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      current = new URL(loc, u).href;
      continue;
    }
    return { status: res.status, finalUrl: u, html: await readCapped(res) };
  }
  throw new Error('too many redirects');
}

export async function probe(url, allowHttp = false) {
  try {
    const { status, finalUrl, html } = await fetchFollowing(url, allowHttp);
    const caption = extractCaption(html);
    const redirectedToLogin = finalUrl.pathname.includes('/accounts/login');
    const looksTruncated = /(\.\.\.|…)$/.test(caption);
    return {
      url,
      status,
      finalHost: finalUrl.host,
      redirectedToLogin,
      hasOgDescription: hasMeta(html, 'og:description'),
      hasOgTitle: hasMeta(html, 'og:title'),
      captionLength: caption.length,
      looksTruncated,
      usable: !redirectedToLogin && caption.length >= MIN_CAPTION && !looksTruncated,
      caption,
    };
  } catch (e) {
    return { url, status: 0, finalHost: '', redirectedToLogin: false, hasOgDescription: false, hasOgTitle: false, captionLength: 0, looksTruncated: false, usable: false, caption: '', error: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.log('usage: node spike-instagram.mjs urls.txt');
    return;
  }
  const urls = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const allowHttp = process.env.SPIKE_ALLOW_HTTP === '1';
  const pause = process.env.SPIKE_PAUSE_MS !== undefined ? Number(process.env.SPIKE_PAUSE_MS) : 1500;
  const rows = [];
  for (let i = 0; i < urls.length; i++) {
    if (i > 0) await sleep(pause);
    const { caption, url, ...row } = await probe(urls[i], allowHttp);
    rows.push({ url, caption, ...row });
    console.log(`\n[${i + 1}/${urls.length}] ${url}`);
    for (const [k, v] of Object.entries(row)) console.log(`  ${k}: ${v}`);
  }
  const usable = rows.filter((r) => r.usable);
  console.log(`\nSummary: usable ${usable.length} of ${rows.length}`);
  console.log(`Verdict: ${usable.length >= Math.ceil(rows.length / 2) && rows.length > 0 ? 'GO' : 'NO-GO'}`);
  for (const r of usable) console.log(`\n${r.url}\n  ${r.caption.slice(0, 200).replace(/\n/g, ' / ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

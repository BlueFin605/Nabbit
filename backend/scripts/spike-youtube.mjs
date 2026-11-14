// Spike: can we read YouTube watch pages and captions anonymously from AWS? (NAB-166, spec section C)
// Usage (AWS CloudShell, Node 24): node spike-youtube.mjs [urls.txt]  (no file = built-in default list)
// Plain GET, honest User-Agent, no cookies, no auth. Always exits 0. Zero dependencies.
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const UA = 'Nabbit-spike/1.0';
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MIN_CAPTION = 200;

export const DEFAULT_URLS = [
  'https://youtu.be/yk6tQfArMvw',
];

export function resolveUrls(file) {
  if (!file) return DEFAULT_URLS;
  return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function unescapeHtml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Balanced-brace scan from the first "{" after `ytInitialPlayerResponse =`, aware of JSON strings.
export function extractPlayerResponse(html) {
  const m = /ytInitialPlayerResponse\s*=\s*/.exec(html);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  if (html[start] !== '{') return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const isEnglish = (t) => /^en(-|$)/i.test(t.languageCode ?? '');

// Manual English, then auto (asr) English, then the first track.
export function selectCaptionTrack(tracks) {
  if (!tracks?.length) return undefined;
  return tracks.find((t) => isEnglish(t) && t.kind !== 'asr') ?? tracks.find((t) => isEnglish(t)) ?? tracks[0];
}

const squash = (s) => s.replace(/\s+/g, ' ').trim();

// Plain text from a json3 body or timed-text XML (text / p+s elements), no timestamps.
export function flattenCaptions(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const events = JSON.parse(trimmed).events ?? [];
      return squash(events.map((e) => (e.segs ?? []).map((s) => s.utf8 ?? '').join('')).join(' '));
    } catch {
      return '';
    }
  }
  const parts = [];
  for (const m of trimmed.matchAll(/<(text|p)\b[^>]*>([\s\S]*?)<\/\1>/g)) parts.push(unescapeHtml(m[2].replace(/<[^>]+>/g, '')));
  return squash(parts.join(' '));
}

export function extractDescriptionLinks(description) {
  const links = [];
  for (const m of description.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const link = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (!links.includes(link)) links.push(link);
  }
  return links;
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

async function fetchFollowing(url, allowHttp, accept = 'text/html') {
  let current = url;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const u = new URL(current);
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw new Error('only https is allowed');
    const res = await fetch(u, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept, 'accept-language': 'en' },
      signal: globalThis.AbortSignal.timeout(TIMEOUT_MS),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      current = new URL(loc, u).href;
      continue;
    }
    return { status: res.status, finalUrl: u, body: await readCapped(res) };
  }
  throw new Error('too many redirects');
}

// Try json3 first, then the plain (XML) form. Returns the text and every HTTP status seen.
async function fetchCaptionText(baseUrl, allowHttp) {
  const statuses = [];
  for (const fmt of ['json3', undefined]) {
    const u = new URL(baseUrl);
    if (fmt) u.searchParams.set('fmt', fmt);
    const { status, body } = await fetchFollowing(u.href, allowHttp, '*/*');
    statuses.push(status);
    const text = status === 200 ? flattenCaptions(body) : '';
    if (text) return { text, statuses };
  }
  return { text: '', statuses };
}

export async function probe(url, allowHttp = false) {
  const row = { url, status: 0, wall: false, playerParsed: false, title: '', descriptionLength: 0, tracks: '', captionLength: 0, captionStatus: '', captionResult: 'no track', usable: false, links: [] };
  try {
    const { status, finalUrl, body } = await fetchFollowing(url, allowHttp);
    const player = extractPlayerResponse(body);
    const description = player?.videoDetails?.shortDescription ?? '';
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    Object.assign(row, {
      status,
      wall: finalUrl.host === 'consent.youtube.com' || !player,
      playerParsed: Boolean(player),
      title: player?.videoDetails?.title ?? '',
      descriptionLength: description.length,
      tracks: tracks.map((t) => `${t.languageCode}/${t.kind === 'asr' ? 'asr' : 'manual'}`).join(', '),
      links: extractDescriptionLinks(description),
    });
    const track = selectCaptionTrack(tracks);
    if (track?.baseUrl) {
      const { text, statuses } = await fetchCaptionText(track.baseUrl, allowHttp);
      row.captionLength = text.length;
      row.captionStatus = [...new Set(statuses)].join(', ');
      const bad = statuses.find((st) => st !== 200);
      row.captionResult = text ? 'ok' : bad !== undefined ? `caption fetch failed (status ${bad})` : 'empty text';
    }
    row.usable = row.playerParsed && row.captionLength >= MIN_CAPTION;
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  }
  return row;
}

async function main() {
  const file = process.argv[2];
  let urls;
  try {
    urls = resolveUrls(file);
  } catch (e) {
    console.log(`cannot read urls file ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!file) console.log('no urls file given, using the built-in default list');
  const allowHttp = process.env.SPIKE_ALLOW_HTTP === '1';
  const pause = process.env.SPIKE_PAUSE_MS !== undefined ? Number(process.env.SPIKE_PAUSE_MS) : 1500;
  const rows = [];
  for (let i = 0; i < urls.length; i++) {
    if (i > 0) await sleep(pause);
    const { url, links, ...row } = await probe(urls[i], allowHttp);
    rows.push({ url, links, ...row });
    console.log(`\n[${i + 1}/${urls.length}] ${url}`);
    for (const [k, v] of Object.entries(row)) console.log(`  ${k}: ${v}`);
    console.log(`  links: ${links.length ? links.join(' ') : '(none)'}`);
  }
  const usable = rows.filter((r) => r.usable).length;
  console.log(`\nSummary: usable ${usable} of ${rows.length}`);
  const verdict = rows.length < 3 ? 'INCONCLUSIVE (need 3+ URLs; pass a urls file)' : usable >= 2 && usable >= (rows.length * 2) / 3 ? 'GO' : 'NO-GO';
  console.log(`Verdict: ${verdict}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.log(`spike failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exitCode = 0;
}

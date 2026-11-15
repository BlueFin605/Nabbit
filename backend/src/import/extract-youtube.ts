/** Hosts treated as YouTube (https only, exact match after lowercasing and dropping one trailing dot). */
export const YOUTUBE_HOSTS: readonly string[] = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

/**
 * E2E hook: extra hostnames (comma separated) that count as YouTube, so a fixture host can exercise the
 * auto-fetch path. Honoured ONLY when NODE_ENV=development (the local dev server); a production build ignores it.
 */
function e2eYoutubeHosts(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== 'development' || !env.NABBIT_E2E_YOUTUBE_HOSTS) return [];
  return env.NABBIT_E2E_YOUTUBE_HOSTS.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

const hostOf = (u: URL): string => u.hostname.toLowerCase().replace(/\.$/, '');

export function isYoutubeUrl(rawUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const u = new URL(rawUrl);
    const host = hostOf(u);
    return u.protocol === 'https:' && (YOUTUBE_HOSTS.includes(host) || e2eYoutubeHosts(env).includes(host));
  } catch {
    return false;
  }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Video id from /watch?v=, youtu.be/<id>, /shorts/<id>, /live/<id> or /embed/<id> on a YouTube host; undefined when absent or malformed. */
export function youtubeVideoId(rawUrl: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return undefined;
    const host = hostOf(u);
    let id: string | undefined;
    if (host === 'youtu.be') {
      id = u.pathname.split('/')[1];
    } else if (YOUTUBE_HOSTS.includes(host) || e2eYoutubeHosts(env).includes(host)) {
      if (u.pathname === '/watch') id = u.searchParams.get('v') ?? undefined;
      else {
        const m = /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(u.pathname);
        id = m?.[1];
      }
    }
    // /embed/videoseries?list=... is an embedded playlist; its "id" happens to be 11 characters
    return id !== undefined && id !== 'videoseries' && VIDEO_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** https://www.youtube.com/watch?v=<id> (si, t, list and the rest dropped); undefined when there is no valid id. */
export function canonicalYoutubeUrl(rawUrl: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = youtubeVideoId(rawUrl, env);
  if (!id) return undefined;
  const host = hostOf(new URL(rawUrl));
  // an e2e fixture host keeps its own host so the fixture resolves; real hosts normalise to www.youtube.com
  const canonicalHost = YOUTUBE_HOSTS.includes(host) ? 'www.youtube.com' : host;
  return `https://${canonicalHost}/watch?v=${id}`;
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

export interface YoutubePlayerData {
  title: string;
  description: string;
  captionTracks: CaptionTrack[];
}

// Bounded work on hostile pages; nothing is executed.
const MAX_HTML = 5_000_000;
const MAX_TRACKS = 50;

type Json = unknown;
const isObj = (v: Json): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: Json): string => (typeof v === 'string' ? v : '');

/** Balanced-brace scan (JSON-string aware) from the first "{" after `ytInitialPlayerResponse =`. */
function scanPlayerResponse(html: string): Json {
  for (const m of html.matchAll(/ytInitialPlayerResponse\s*=\s*/g)) {
    const start = m.index + m[0].length;
    if (html[start] !== '{') continue;
    return scanObject(html, start);
  }
  return undefined;
}

function scanObject(html: string, start: number): Json {
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
        return JSON.parse(html.slice(start, i + 1)) as Json;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function extractPlayerData(html: string, env: NodeJS.ProcessEnv = process.env): YoutubePlayerData | undefined {
  const player = scanPlayerResponse(html.slice(0, MAX_HTML));
  if (!isObj(player)) return undefined;
  const details = isObj(player.videoDetails) ? player.videoDetails : {};
  const captions = isObj(player.captions) ? player.captions : {};
  const renderer = isObj(captions.playerCaptionsTracklistRenderer) ? captions.playerCaptionsTracklistRenderer : {};
  const raw = Array.isArray(renderer.captionTracks) ? (renderer.captionTracks as Json[]) : [];
  const captionTracks: CaptionTrack[] = [];
  for (const t of raw.slice(0, MAX_TRACKS)) {
    if (!isObj(t) || !str(t.baseUrl) || !isYoutubeUrl(str(t.baseUrl), env)) continue;
    const track: CaptionTrack = { baseUrl: str(t.baseUrl), languageCode: str(t.languageCode) };
    if (typeof t.kind === 'string') track.kind = t.kind;
    captionTracks.push(track);
  }
  return { title: str(details.title), description: str(details.shortDescription), captionTracks };
}

const isEnglish = (t: CaptionTrack): boolean => /^en(-|$)/i.test(t.languageCode);

/** Manual English, then auto-generated English (kind === 'asr'), then the first track. */
export function pickCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  if (!tracks.length) return undefined;
  return tracks.find((t) => isEnglish(t) && t.kind !== 'asr') ?? tracks.find(isEnglish) ?? tracks[0];
}

/** Code point to string; invalid, out-of-range, NUL and surrogate values become U+FFFD instead of throwing. */
function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Timed-text XML beyond this many characters is ignored (the LLM input is capped at 20,000 chars anyway). */
export const MAX_CAPTION_XML_CHARS = 512 * 1024;

/** Plain text from a json3 body or timed-text XML (<text>/<p> elements): no timestamps, entities decoded, whitespace collapsed. */
export function captionsToText(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Json;
      const events = isObj(parsed) && Array.isArray(parsed.events) ? (parsed.events as Json[]) : [];
      const lines = events.map((e) => {
        const segs = isObj(e) && Array.isArray(e.segs) ? (e.segs as Json[]) : [];
        return segs.map((s) => (isObj(s) ? str(s.utf8) : '')).join('');
      });
      return squash(lines.join(' '));
    } catch {
      return '';
    }
  }
  // One linear pass over the <text>/<p> tags (no backtracking regex: a hostile body of unclosed tags stays O(n)).
  // `[^<>]*` stops at the next '<', so each tag match is bounded by the distance to the next tag.
  const xml = trimmed.slice(0, MAX_CAPTION_XML_CHARS);
  const parts: string[] = [];
  let open: string | undefined;
  let start = 0;
  for (const m of xml.matchAll(/<(\/?)(text|p)\b[^<>]*>/g)) {
    if (!m[1]) {
      open = m[2];
      start = m.index + m[0].length;
    } else if (open === m[2]) {
      // timedtext bodies are commonly double-encoded (&amp;#39;), so decode twice
      parts.push(decodeEntities(decodeEntities(xml.slice(start, m.index).replace(/<[^<>]*>/g, ''))));
      open = undefined;
    }
  }
  return squash(parts.join(' '));
}

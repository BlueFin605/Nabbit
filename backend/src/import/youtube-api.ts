// YouTube Data API v3 fallback for a video's title + description, used when the anonymous watch page is walled or empty.
// The API key lives in an SSM SecureString whose NAME is in env YOUTUBE_API_KEY_PARAM (unset = feature off). The key is
// never logged or returned; every failure resolves to `undefined` so an import never fails because of this fallback.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export interface YoutubeSnippet {
  title: string;
  description: string;
}

/** Why a snippet could not be had (logged by the caller; never contains the key). */
export type SnippetFailure = 'off' | 'no_key' | 'timeout' | 'status' | 'bad_json' | 'not_found' | 'error';

export interface YoutubeApiDeps {
  /** Resolves the API key, or undefined when unavailable. Default: SSM GetParameter WithDecryption, cached per Lambda. */
  getKey?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const YOUTUBE_API_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_CHARS = 200_000;
const KEY_FAILURE_TTL_MS = 60_000;

let cachedKey: { param: string; key: string } | undefined;
let keyFailure: { param: string; until: number } | undefined;

/** Test hook: forget the cached key / failure. */
export function resetYoutubeApiCache(): void {
  cachedKey = undefined;
  keyFailure = undefined;
}

export const youtubeApiConfigured = (): boolean => !!process.env.YOUTUBE_API_KEY_PARAM?.trim();

async function keyFromSsm(): Promise<string | undefined> {
  const param = process.env.YOUTUBE_API_KEY_PARAM?.trim();
  if (!param) return undefined;
  if (cachedKey?.param === param) return cachedKey.key;
  if (keyFailure?.param === param && Date.now() < keyFailure.until) return undefined;
  try {
    const out = await new SSMClient({}).send(new GetParameterCommand({ Name: param, WithDecryption: true }));
    const key = out.Parameter?.Value?.trim();
    if (!key) throw new Error('empty');
    cachedKey = { param, key };
    return key;
  } catch {
    keyFailure = { param, until: Date.now() + KEY_FAILURE_TTL_MS }; // do not hammer SSM on every import
    return undefined;
  }
}

/**
 * GET videos?part=snippet&id=<id>. `reason` is set whenever `snippet` is undefined. The URL (which carries the key) is
 * never logged, and error messages from fetch are not surfaced.
 */
export async function fetchVideoSnippet(
  videoId: string,
  deps: YoutubeApiDeps = {},
): Promise<{ snippet?: YoutubeSnippet; reason?: SnippetFailure }> {
  if (!deps.getKey && !youtubeApiConfigured()) return { reason: 'off' };
  let key: string | undefined;
  try {
    key = await (deps.getKey ?? keyFromSsm)();
  } catch {
    key = undefined;
  }
  if (!key) return { reason: 'no_key' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? YOUTUBE_API_TIMEOUT_MS);
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`;
    const res = await (deps.fetchImpl ?? fetch)(url, { method: 'GET', signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return { reason: 'status' };
    const text = (await res.text()).slice(0, MAX_RESPONSE_CHARS);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { reason: 'bad_json' };
    }
    const items = (json as { items?: unknown })?.items;
    const sn = Array.isArray(items) ? (items[0] as { snippet?: { title?: unknown; description?: unknown } } | undefined)?.snippet : undefined;
    if (!sn || typeof sn !== 'object') return { reason: 'not_found' };
    return {
      snippet: {
        title: typeof sn.title === 'string' ? sn.title : '',
        description: typeof sn.description === 'string' ? sn.description : '',
      },
    };
  } catch {
    return { reason: ctl.signal.aborted ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

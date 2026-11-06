import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { MAX_IMAGE_BYTES } from '../image-limits.js';
import { ImportError, type ImportErrorCode } from './import-error.js';

export { ImportError } from './import-error.js';
export type { ImportErrorCode } from './import-error.js';

/** url = final URL after redirects (fragment stripped). */
export interface FetchedPage {
  url: string;
  html: string;
}

export interface SafeFetchDeps {
  /** Resolve a hostname to ALL of its IP addresses. Defaults to node:dns lookup (all: true). */
  resolve?: (host: string) => Promise<string[]>;
  /**
   * Transport. Called once per hop with `redirect: 'manual'` and a `pinnedAddress` extra init field:
   * the already-validated IP the connection MUST be made to (the URL host is kept for SNI/Host only),
   * plus `pinnedAddresses`: every validated IP in connect order (IPv4 first) for fallback.
   * The default implementation honours it; an injected one (tests) can assert on it.
   */
  fetchImpl?: typeof fetch;
  /** Total time budget for the whole operation including redirects. Default 5000. */
  timeoutMs?: number;
}

export const MAX_REDIRECTS = 4;
export const MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 5000;
// Contact URL is injected by the stack from config.domain; no domain is baked into the public source.
const CONTACT_URL = process.env.IMPORT_CONTACT_URL;
export const USER_AGENT = `Nabbit-RecipeImporter/1.0 (${CONTACT_URL ? `+${CONTACT_URL}; ` : ''}recipe import on behalf of a user)`;

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function blockedIPv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this network" incl. unspecified
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local incl. metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Parse an IPv6 literal (no brackets, no zone) into a 128-bit bigint, or null. */
function parseIPv6(ip: string): bigint | null {
  if (isIP(ip) !== 6 || ip.includes('%')) return null;
  let head = ip;
  let tail4: number[] | null = null;
  const lastColon = ip.lastIndexOf(':');
  const lastPart = ip.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    tail4 = parseIPv4(lastPart);
    if (!tail4) return null;
    head = ip.slice(0, lastColon + 1) + '0:0'; // placeholder for two groups
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === '' ? [] : s.split(':'));
  const left = toGroups(halves[0] ?? '');
  const right = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail4) {
    value = (value & ~0xffffffffn) | (BigInt(tail4[0]!) << 24n) | (BigInt(tail4[1]!) << 16n) | (BigInt(tail4[2]!) << 8n) | BigInt(tail4[3]!);
  }
  return value;
}

function v4FromBits(n: bigint): number[] {
  return [Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn)];
}

function inV6(value: bigint, prefix: bigint, bits: bigint): boolean {
  return value >> (128n - bits) === prefix >> (128n - bits);
}

function blockedIPv6(v: bigint): boolean {
  const low32 = v & 0xffffffffn;
  if (inV6(v, 0n, 96n)) return true; // ::, ::1, IPv4-compatible ::a.b.c.d
  if (inV6(v, 0xffffn << 32n, 96n)) return blockedIPv4(v4FromBits(low32)); // ::ffff:0:0/96 IPv4-mapped
  if (inV6(v, 0x64ff9bn << 96n, 96n)) return blockedIPv4(v4FromBits(low32)); // 64:ff9b::/96 NAT64
  if (inV6(v, 0x64ff9b0001n << 80n, 48n)) return true; // 64:ff9b:1::/48 local-use NAT64
  if (inV6(v, 0x2002n << 112n, 16n)) return blockedIPv4(v4FromBits((v >> 80n) & 0xffffffffn)); // 6to4
  if (inV6(v, 0x20010000n << 96n, 32n)) return true; // Teredo
  if (inV6(v, 0x20010db8n << 96n, 32n)) return true; // documentation
  if (inV6(v, 0x0100n << 112n, 64n)) return true; // discard-only
  // Allow only global unicast 2000::/3 (everything else: ULA fc00::/7, link-local fe80::/10,
  // site-local fec0::/10, multicast ff00::/8, reserved...).
  return !inV6(v, 0x2n << 124n, 3n);
}

/** True if the address must never be fetched. Unparseable input is treated as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const o = parseIPv4(ip);
    return o === null || blockedIPv4(o);
  }
  if (kind === 6) {
    const v = parseIPv6(ip);
    return v === null || blockedIPv6(v);
  }
  return true;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function parseSafeUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ImportError('bad_url', 'Not a valid URL');
  }
  if (u.protocol !== 'https:') throw new ImportError('bad_url', 'Only https URLs are allowed');
  if (u.username || u.password) throw new ImportError('bad_url', 'Credentials in URL are not allowed');
  if (u.port !== '' && u.port !== '443') throw new ImportError('bad_url', 'Only port 443 is allowed');
  if (!u.hostname) throw new ImportError('bad_url', 'Missing host');
  u.hash = '';
  return u;
}

function isLocalName(host: string): boolean {
  const h = host.replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost');
}

/**
 * IPv4 first (stable), then IPv6: Lambda without a VPC has no IPv6 egress, so an AAAA sorted first
 * by the resolver would otherwise fail dual-stack hosts.
 */
export function orderAddresses(addrs: string[]): string[] {
  return [...addrs.filter((a) => isIP(a) === 4), ...addrs.filter((a) => isIP(a) !== 4)];
}

/**
 * Validate the hop's host and return the validated IPs to connect to, in connect order (IPv4 first).
 * ANY blocked address in the answer blocks the whole host.
 */
async function validatedAddresses(u: URL, resolve: (h: string) => Promise<string[]>): Promise<string[]> {
  const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new ImportError('blocked_address', 'Address is not allowed');
    return [host];
  }
  if (isLocalName(host)) throw new ImportError('blocked_address', 'Address is not allowed');
  let addrs: string[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new ImportError('bad_url', 'Host could not be resolved');
  }
  if (!Array.isArray(addrs) || addrs.length === 0) throw new ImportError('bad_url', 'Host could not be resolved');
  // ANY blocked address poisons the whole host (defends mixed A/AAAA answers).
  if (addrs.some(isBlockedAddress)) throw new ImportError('blocked_address', 'Address is not allowed');
  return orderAddresses(addrs);
}

// ---------------------------------------------------------------------------
// Default transport: HTTPS to a pinned IP, TLS verified against the original hostname
// ---------------------------------------------------------------------------

type PinnedInit = Omit<RequestInit, 'headers'> & {
  /** First (preferred) validated address; kept for transports that only take one. */
  pinnedAddress?: string;
  /** All validated addresses in connect order (IPv4 first). The default transport falls back through them. */
  pinnedAddresses?: string[];
  headers?: Record<string, string>;
};

/**
 * Try each (already validated) address in order until one yields a response. Stops at once if the
 * signal is aborted. Throws the last error if every address fails.
 */
export async function connectInOrder<T>(
  addresses: string[],
  tryConnect: (address: string) => Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  let lastError: unknown = new Error('No addresses to connect to');
  for (const address of addresses) {
    if (signal?.aborted) throw lastError;
    try {
      return await tryConnect(address);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/** Convert a node IncomingMessage to a fetch Response. Never throws for any status 100-999. */
export function responseFromIncoming(res: Readable & Pick<IncomingMessage, 'statusCode' | 'headers'>): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    try {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    } catch {
      /* skip a header fetch refuses to represent */
    }
  }
  const status = res.statusCode ?? 0;
  const nullBody = status === 204 || status === 205 || status === 304 || status < 200;
  // Response only accepts 200-599; anything else from a hostile upstream becomes 502.
  const safeStatus = status < 200 || status > 599 ? 502 : status;
  if (nullBody) res.destroy();
  return new Response(nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), {
    status: safeStatus,
    headers,
  });
}

export interface PinnedTlsOptions {
  /** Test-only: extra trusted CA. Never set in production; verification stays on. */
  ca?: string | Buffer;
  /** Test-only port override. */
  port?: number;
}

function requestOnce(input: string | URL, init: PinnedInit, address: string, tls: PinnedTlsOptions): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const u = new URL(String(input));
    const hostname = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
    const req = httpsRequest(
      {
        host: address,
        port: tls.port ?? 443,
        servername: isIP(hostname) ? undefined : hostname, // SNI + certificate name check
        method: 'GET',
        path: u.pathname + u.search,
        headers: { ...(init.headers ?? {}), host: u.host },
        signal: init.signal ?? undefined,
        ...(tls.ca ? { ca: tls.ca } : {}),
      },
      (res) => {
        try {
          resolve(responseFromIncoming(res));
        } catch (e) {
          res.destroy();
          reject(e);
        }
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export function createPinnedFetch(tls: PinnedTlsOptions = {}): typeof fetch {
  return ((input: string | URL, init: PinnedInit = {}): Promise<Response> => {
    const hostname = new URL(String(input)).hostname;
    const addresses = init.pinnedAddresses?.length ? init.pinnedAddresses : [init.pinnedAddress ?? hostname];
    return connectInOrder(addresses, (a) => requestOnce(input, init, a, tls), init.signal);
  }) as unknown as typeof fetch;
}

const pinnedFetch = createPinnedFetch();

async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((r) => r.address);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function isHtmlType(contentType: string | null): boolean {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return t === 'text/html' || t === 'application/xhtml+xml';
}

function decoderFor(contentType: string | null): TextDecoder {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType ?? '');
  if (m) {
    try {
      return new TextDecoder(m[1]);
    } catch {
      /* unknown charset: fall back to utf-8 */
    }
  }
  return new TextDecoder('utf-8');
}

export interface GuardedFetchOptions {
  accept: string;
  isAllowedType: (contentType: string) => boolean;
  notAllowedCode: ImportErrorCode;
  maxBytes: number;
  /** When set, every redirect hop must stay on this origin; a hop elsewhere is rejected before it is resolved or fetched. */
  allowedOrigin?: string;
}
export interface GuardedResponse {
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

export async function guardedFetch(rawUrl: string, opts: GuardedFetchOptions, deps: SafeFetchDeps = {}): Promise<GuardedResponse> {
  const resolve = deps.resolve ?? defaultResolve;
  const fetchImpl = deps.fetchImpl ?? pinnedFetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ImportError('timeout', 'Timed out fetching the page'));
      controller.abort(); // after reject, so the timeout error wins the race
    }, timeoutMs);
  });
  deadline.catch(() => undefined); // avoid unhandled rejection if nothing is racing it
  const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, deadline]);

  try {
    let current = parseSafeUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      const addresses = await guard(validatedAddresses(current, resolve));

      let res: Response;
      try {
        const init: PinnedInit = {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          pinnedAddress: addresses[0]!,
          pinnedAddresses: addresses,
          headers: {
            'user-agent': USER_AGENT,
            accept: opts.accept,
            'accept-encoding': 'identity',
          },
        };
        res = await guard(fetchImpl(current.href, init));
      } catch (e) {
        if (e instanceof ImportError) throw e;
        throw new ImportError('bad_status', 'Could not fetch the page');
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        void res.body?.cancel().catch(() => undefined);
        if (!location) throw new ImportError('bad_status', 'Redirect without a Location');
        if (hop >= MAX_REDIRECTS) throw new ImportError('too_many_redirects', 'Too many redirects');
        let next: string;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new ImportError('bad_url', 'Invalid redirect target');
        }
        current = parseSafeUrl(next); // re-validated (scheme/port/creds) now, address at top of loop
        if (opts.allowedOrigin && current.origin !== opts.allowedOrigin) throw new ImportError('bad_url', 'Redirected to a different origin');
        continue;
      }

      if (res.status < 200 || res.status > 299 || res.status === 204) {
        void res.body?.cancel().catch(() => undefined);
        throw new ImportError('bad_status', `Upstream returned ${res.status}`);
      }
      const contentType = res.headers.get('content-type');
      if (!opts.isAllowedType(contentType ?? '')) {
        void res.body?.cancel().catch(() => undefined);
        throw new ImportError(opts.notAllowedCode, opts.notAllowedCode === 'not_html' ? 'Page is not HTML' : 'Not an allowed content type');
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        void res.body?.cancel().catch(() => undefined);
        throw new ImportError('too_large', 'Page is too large');
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        try {
          for (;;) {
            let r: ReadableStreamReadResult<Uint8Array>;
            try {
              r = await guard(reader.read());
            } catch (e) {
              if (e instanceof ImportError) throw e;
              throw new ImportError('bad_status', 'Failed reading the page');
            }
            if (r.done) break;
            total += r.value.byteLength;
            if (total > opts.maxBytes) throw new ImportError('too_large', 'Page is too large');
            chunks.push(r.value);
          }
        } finally {
          void reader.cancel().catch(() => undefined);
        }
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      return { url: current.href, contentType: contentType ?? '', bytes: buf };
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1';

export async function safeFetch(rawUrl: string, deps: SafeFetchDeps = {}): Promise<FetchedPage> {
  const r = await guardedFetch(
    rawUrl,
    { accept: HTML_ACCEPT, isAllowedType: (t) => isHtmlType(t), notAllowedCode: 'not_html', maxBytes: MAX_BYTES },
    deps,
  );
  return { url: r.url, html: decoderFor(r.contentType).decode(r.bytes) };
}

export type ImageContentType = 'image/jpeg' | 'image/png' | 'image/webp';
export interface FetchedImage {
  url: string;
  contentType: ImageContentType;
  bytes: Uint8Array;
}

const IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

function sniffImageType(b: Uint8Array): ImageContentType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export async function safeFetchImage(rawUrl: string, deps: SafeFetchDeps = {}): Promise<FetchedImage> {
  const r = await guardedFetch(
    rawUrl,
    {
      accept: 'image/jpeg,image/png,image/webp',
      isAllowedType: (t) => IMAGE_TYPES.includes(t.split(';')[0]!.trim().toLowerCase()),
      notAllowedCode: 'not_image',
      maxBytes: MAX_IMAGE_BYTES,
    },
    deps,
  );
  const declared = r.contentType.split(';')[0]!.trim().toLowerCase();
  if (sniffImageType(r.bytes) !== declared) throw new ImportError('not_image', 'Image content does not match its type');
  return { url: r.url, contentType: declared as ImageContentType, bytes: r.bytes };
}

function isJsonType(contentType: string | null): boolean {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return t === 'application/json' || t === 'text/json' || t.endsWith('+json');
}

/** Same SSRF guard / redirect / timeout handling as safeFetch, for a small JSON document (e.g. Gatsby page-data.json). */
export async function safeFetchJson(
  rawUrl: string,
  deps: SafeFetchDeps = {},
  maxBytes: number = MAX_BYTES,
  opts: { allowedOrigin?: string } = {},
): Promise<{ url: string; text: string }> {
  const r = await guardedFetch(
    rawUrl,
    { accept: 'application/json', isAllowedType: isJsonType, notAllowedCode: 'not_html', maxBytes, ...(opts.allowedOrigin ? { allowedOrigin: opts.allowedOrigin } : {}) },
    deps,
  );
  return { url: r.url, text: new TextDecoder('utf-8').decode(r.bytes) };
}

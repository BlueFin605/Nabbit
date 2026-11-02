/**
 * E2E test hook, LOCAL DEV SERVER ONLY (imported by local.ts and by nothing under src/handlers).
 *
 * The production SSRF guard (import/safe-fetch.ts) is NOT touched: it still demands https on 443 and
 * rejects private/loopback addresses. This only supplies the guard's existing injectable dependencies
 * so a Playwright run can import a recipe from a local static fixture server:
 *   - `resolve` answers one made-up hostname with a public-looking IP (so the real guard logic runs
 *     and passes) and refuses every other host (no real DNS, no real internet);
 *   - `fetchImpl` serves that one hostname's paths from the fixture origin and throws for anything else.
 *
 * Active only when NODE_ENV=development AND NABBIT_E2E_FIXTURE_FETCH=1 AND NABBIT_E2E_FIXTURE_ORIGIN is a
 * loopback http origin. Any other combination (including NODE_ENV=production) returns undefined.
 */
import type { SafeFetchDeps } from './import/safe-fetch.js';

/** The only hostname the hook answers for; use https://nabbit-fixtures.test/<path> in the importer. */
export const FIXTURE_HOST = 'nabbit-fixtures.test';
/** A routable-looking address the guard accepts (never connected to; the fetch is redirected). */
const FIXTURE_ADDRESS = '93.184.216.34';

function loopbackOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    return u.protocol === 'http:' && loopback && u.port ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

export function fixtureFetchDeps(env: NodeJS.ProcessEnv = process.env): SafeFetchDeps | undefined {
  if (env.NODE_ENV !== 'development' || env.NABBIT_E2E_FIXTURE_FETCH !== '1') return undefined;
  const origin = loopbackOrigin(env.NABBIT_E2E_FIXTURE_ORIGIN);
  if (!origin) return undefined;
  return {
    resolve: async (host) => {
      if (host !== FIXTURE_HOST) throw new Error('fixture mode: unknown host');
      return [FIXTURE_ADDRESS];
    },
    fetchImpl: ((input: string | URL, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.hostname !== FIXTURE_HOST) return Promise.reject(new Error('fixture mode: unknown host'));
      return fetch(origin + u.pathname + u.search, { method: 'GET', redirect: 'manual', headers: init?.headers, signal: init?.signal });
    }) as typeof fetch,
  };
}

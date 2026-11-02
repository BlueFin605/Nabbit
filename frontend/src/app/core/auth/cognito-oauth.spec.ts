import { createHash, webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { buildAuthorizeUrl, handleOAuthCallback, pkceChallenge } from './cognito-oauth';

beforeAll(() => {
  // jsdom lacks WebCrypto and TextEncoder; use Node's.
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  if (!globalThis.TextEncoder) Object.assign(globalThis, { TextEncoder });
});

beforeEach(() => sessionStorage.clear());

describe('cognito-oauth (PKCE)', () => {
  it('builds an authorize URL with state and an S256 challenge matching the stored verifier', async () => {
    const url = new URL(await buildAuthorizeUrl());
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(sessionStorage.getItem('oauth_state'));
    const verifier = sessionStorage.getItem('oauth_code_verifier') as string;
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(url.searchParams.get('code_challenge')).toBe(expected);
  });

  it('computes the RFC 7636 example challenge', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('rejects a callback whose state does not match', async () => {
    sessionStorage.setItem('oauth_state', 'good');
    sessionStorage.setItem('oauth_code_verifier', 'v');
    await expect(handleOAuthCallback('code', 'bad')).rejects.toMatchObject({ code: 'state_mismatch' });
  });
});

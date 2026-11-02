import {
  CognitoAccessToken,
  CognitoIdToken,
  CognitoRefreshToken,
  CognitoUserSession,
} from 'amazon-cognito-identity-js';
import { environment } from '../../../environments/environment';

export type OAuthErrorCode = 'config_missing' | 'state_mismatch' | 'token_exchange_failed' | 'missing_tokens';

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface AuthResult {
  session: CognitoUserSession;
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

const STATE_KEY = 'oauth_state';
const VERIFIER_KEY = 'oauth_code_verifier';

function assertConfigured(): { domain: string; clientId: string; redirectUri: string } {
  const { domain, clientId, redirectUri } = environment.cognito;
  if (!domain || !clientId || !redirectUri) {
    throw new OAuthError(
      'config_missing',
      'Cognito Hosted UI is not configured. Set NG_APP_COGNITO_DOMAIN, NG_APP_COGNITO_CLIENT_ID, NG_APP_COGNITO_REDIRECT_URI.',
    );
  }
  return { domain, clientId, redirectUri };
}

/**
 * Builds the Cognito Hosted UI /oauth2/authorize URL (authorization-code + PKCE S256). The CSRF `state` and the
 * PKCE verifier are kept in sessionStorage until the callback. Separate from {@link redirectToLogin} so it can
 * be tested without triggering jsdom navigation.
 */
export async function buildAuthorizeUrl(): Promise<string> {
  const { domain, clientId, redirectUri } = assertConfigured();

  const state = randomString(32);
  const verifier = randomString(64);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    scope: 'openid email profile',
    code_challenge_method: 'S256',
    code_challenge: await pkceChallenge(verifier),
  });

  return `https://${domain}/oauth2/authorize?${params.toString()}`;
}

export async function redirectToLogin(): Promise<void> {
  window.location.href = await buildAuthorizeUrl();
}

export async function handleOAuthCallback(code: string, state: string): Promise<AuthResult> {
  const savedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!savedState || state !== savedState || !verifier) {
    throw new OAuthError('state_mismatch', 'State mismatch. Possible CSRF attack.');
  }
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);

  const { domain, clientId, redirectUri } = assertConfigured();

  const response = await fetch(`https://${domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }).toString(),
  });

  if (!response.ok) {
    throw new OAuthError('token_exchange_failed', 'Failed to exchange authorization code for tokens');
  }

  const tokens = (await response.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
  if (!tokens.id_token || !tokens.access_token) {
    throw new OAuthError('missing_tokens', 'Missing tokens in OAuth response');
  }

  const session = new CognitoUserSession({
    IdToken: new CognitoIdToken({ IdToken: tokens.id_token }),
    AccessToken: new CognitoAccessToken({ AccessToken: tokens.access_token }),
    RefreshToken: new CognitoRefreshToken({ RefreshToken: tokens.refresh_token ?? 'no-refresh-token' }),
  });

  return {
    session,
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? '',
  };
}

/** Cryptographically random string from the unreserved URL alphabet (valid as a PKCE verifier, 43-128 chars). */
function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += chars.charAt(b % chars.length);
  return out;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

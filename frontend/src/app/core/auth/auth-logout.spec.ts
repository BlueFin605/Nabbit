import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { Auth, BROWSER_NAVIGATE } from './auth';
import { USER_POOL } from './cognito-config';
import { buildLogoutUrl } from './cognito-oauth';

const pool = { getCurrentUser: () => null };

function setup() {
  const navigate = jest.fn();
  TestBed.configureTestingModule({
    providers: [
      { provide: USER_POOL, useValue: pool },
      { provide: BROWSER_NAVIGATE, useValue: navigate },
    ],
  });
  return { auth: TestBed.inject(Auth), navigate };
}

describe('buildLogoutUrl', () => {
  it('targets the Hosted UI /logout with client_id and the encoded {origin}/ logout_uri', () => {
    const { domain, clientId } = environment.cognito;
    expect(buildLogoutUrl('https://nabbit.example.com')).toBe(
      `https://${domain}/logout?client_id=${clientId}&logout_uri=https%3A%2F%2Fnabbit.example.com%2F`,
    );
  });
});

describe('Auth.logout', () => {
  const original = environment.disableAuth;
  afterEach(() => {
    (environment as { disableAuth: boolean }).disableAuth = original;
    sessionStorage.clear();
    localStorage.clear();
  });

  it('clears tokens, flags the sign-out and redirects to the Hosted UI logout (auth enabled)', async () => {
    (environment as { disableAuth: boolean }).disableAuth = false;
    const { auth, navigate } = setup();
    await auth.whenReady();
    localStorage.setItem('idToken', 'x');
    expect(auth.logout()).toBe(true);
    expect(localStorage.getItem('idToken')).toBeNull();
    expect(navigate).toHaveBeenCalledWith(buildLogoutUrl());
    expect(auth.takeSignedOutFlag()).toBe(true);
    expect(auth.takeSignedOutFlag()).toBe(false);
  });

  it('does not redirect in disableAuth (dev) mode', async () => {
    (environment as { disableAuth: boolean }).disableAuth = true;
    const { auth, navigate } = setup();
    await auth.whenReady();
    expect(auth.logout()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(auth.isAuthenticated()).toBe(false);
    await auth.redirectToLogin();
    expect(auth.isAuthenticated()).toBe(true);
  });
});

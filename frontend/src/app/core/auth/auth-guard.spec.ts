import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { Auth } from './auth';
import { authGuard } from './auth-guard';

function run(auth: Partial<Auth>, url = '/import?url=https%3A%2F%2Fexample.com') {
  TestBed.configureTestingModule({ providers: [{ provide: Auth, useValue: auth }] });
  return TestBed.runInInjectionContext(() =>
    authGuard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
  ) as Promise<boolean | UrlTree>;
}

describe('authGuard', () => {
  it('allows signed-in users', async () => {
    const auth = { whenReady: () => Promise.resolve(), isAuthenticated: () => true, rememberReturnUrl: jest.fn() };
    expect(await run(auth as unknown as Partial<Auth>)).toBe(true);
    expect(auth.rememberReturnUrl).not.toHaveBeenCalled();
  });

  it('redirects signed-out users to /signin and remembers the wanted URL', async () => {
    const auth = { whenReady: () => Promise.resolve(), isAuthenticated: () => false, rememberReturnUrl: jest.fn() };
    const result = await run(auth as unknown as Partial<Auth>);
    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/signin');
    expect(auth.rememberReturnUrl).toHaveBeenCalledWith('/import?url=https%3A%2F%2Fexample.com');
  });
});

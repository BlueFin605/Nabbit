import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { Auth } from './auth';
import { landingGuard } from './landing-guard';
import { routes } from '../../app.routes';

const takeSignedOutFlag = jest.fn(() => false);

function run(signedIn: boolean) {
  takeSignedOutFlag.mockClear();
  TestBed.configureTestingModule({
    providers: [
      { provide: Auth, useValue: { whenReady: () => Promise.resolve(), isAuthenticated: () => signedIn, takeSignedOutFlag } },
    ],
  });
  return TestBed.runInInjectionContext(() =>
    landingGuard({} as ActivatedRouteSnapshot, { url: '/' } as RouterStateSnapshot),
  ) as Promise<boolean | UrlTree>;
}

describe('landingGuard', () => {
  it('shows the landing page to signed-out visitors', async () => {
    expect(await run(false)).toBe(true);
  });

  it('clears the sign-out flag so a later Sign in is not stuck on "signed out"', async () => {
    await run(false);
    expect(takeSignedOutFlag).toHaveBeenCalledTimes(1);
  });

  it('redirects signed-in users to /recipes', async () => {
    const result = await run(true);
    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/recipes');
  });
});

describe('route table', () => {
  it('serves / publicly behind the landing guard only', () => {
    const root = routes.find((r) => r.path === '')!;
    expect(root.pathMatch).toBe('full');
    expect(root.canActivate).toEqual([landingGuard]);
  });

  it('keeps deep links behind authGuard and signin/callback public', () => {
    for (const p of ['recipes', 'recipes/:id', 'lists', 'import']) {
      expect(routes.find((r) => r.path === p)!.canActivate?.length).toBe(1);
    }
    expect(routes.find((r) => r.path === 'signin')!.canActivate).toBeUndefined();
    expect(routes.find((r) => r.path === 'callback')!.canActivate).toBeUndefined();
    expect(routes.find((r) => r.path === '**')!.redirectTo).toBe('recipes');
  });
});

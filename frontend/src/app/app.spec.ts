import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { App } from './app';
import { Auth } from './core/auth/auth';
import { AvatarMenu } from './core/shell/avatar-menu';

@Component({ template: 'page' })
class Page {}

function setup(authenticated = true, logoutResult = true) {
  const user = signal(authenticated ? { userId: 'u1', email: 'l@x.com', displayName: 'Local Dev User' } : null);
  const auth = {
    user: user.asReadonly(),
    isAuthenticated: () => user() !== null,
    logout: jest.fn(() => logoutResult),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: Auth, useValue: auth },
      provideRouter([
        { path: 'recipes', component: Page },
        { path: 'lists', component: Page },
        { path: 'signin', component: Page },
        { path: 'callback', component: Page },
      ]),
    ],
  });
  const fixture = TestBed.createComponent(App);
  return { fixture, auth, router: TestBed.inject(Router) };
}

async function go(fixture: ComponentFixture<App>, router: Router, url: string) {
  await router.navigateByUrl(url);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

const q = (f: ComponentFixture<App>, sel: string) => (f.nativeElement as HTMLElement).querySelector<HTMLElement>(sel);

describe('App shell', () => {
  it('shows the top bar with the app name and avatar menu when signed in on a normal page', async () => {
    const { fixture, router } = setup();
    await go(fixture, router, '/recipes');
    expect(q(fixture, '.top-bar')).not.toBeNull();
    expect(q(fixture, '.top-bar .app-name')!.textContent).toContain('Nabbit');
    expect(q(fixture, '.top-bar app-avatar-menu')).not.toBeNull();
  });

  it.each(['/signin', '/callback'])('hides the top bar and bottom nav on %s', async (url) => {
    const { fixture, router } = setup();
    await go(fixture, router, url);
    expect(q(fixture, '.top-bar')).toBeNull();
    expect(q(fixture, '.bottom-nav')).toBeNull();
  });

  it('hides the top bar when signed out', async () => {
    const { fixture, router } = setup(false);
    await go(fixture, router, '/recipes');
    expect(q(fixture, '.top-bar')).toBeNull();
  });

  it('keeps Recipes and Lists in the bottom nav and has no Sign out there', async () => {
    const { fixture, router } = setup();
    await go(fixture, router, '/recipes');
    const nav = q(fixture, '.bottom-nav')!;
    expect(nav.textContent).toContain('Recipes');
    expect(nav.textContent).toContain('Lists');
    expect(nav.textContent).not.toContain('Sign out');
    expect(nav.querySelectorAll('.nav-item').length).toBe(2);
  });

  it('calls Auth.logout when the menu emits signOut, and goes to /signin when there is no redirect', async () => {
    const { fixture, auth, router } = setup(true, false);
    await go(fixture, router, '/recipes');
    const menu = fixture.debugElement.query((d) => d.componentInstance instanceof AvatarMenu);
    (menu.componentInstance as AvatarMenu).signOut.emit();
    await fixture.whenStable();
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(router.url).toBe('/signin');
  });

  it('changes the closeRequested value on every navigation, even to the same URL', async () => {
    const { fixture, router } = setup();
    await go(fixture, router, '/recipes');
    const menuDebug = () => fixture.debugElement.query((d) => d.componentInstance instanceof AvatarMenu);
    const value = () => (menuDebug().componentInstance as AvatarMenu).closeRequested();
    const seen = [value()];
    await go(fixture, router, '/lists');
    seen.push(value());
    await router.navigateByUrl('/lists', { onSameUrlNavigation: 'reload' });
    fixture.detectChanges();
    seen.push(value());
    await go(fixture, router, '/recipes');
    seen.push(value());
    expect(new Set(seen).size).toBe(seen.length);
  });
});

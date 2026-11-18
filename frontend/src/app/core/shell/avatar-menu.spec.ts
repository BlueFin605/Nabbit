import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Auth, type AuthUser } from '../auth/auth';
import { AvatarMenu, avatarColour, avatarInitial } from './avatar-menu';

describe('avatarInitial', () => {
  it('uses the display name first, uppercased', () => {
    expect(avatarInitial({ displayName: 'dean', email: 'zed@x.com' })).toBe('D');
  });
  it('falls back to email when the display name is empty or blank', () => {
    expect(avatarInitial({ displayName: '', email: 'zed@x.com' })).toBe('Z');
    expect(avatarInitial({ displayName: '   ', email: 'zed@x.com' })).toBe('Z');
    expect(avatarInitial({ email: 'zed@x.com' })).toBe('Z');
  });
  it('falls back to ? for null or empty users', () => {
    expect(avatarInitial(null)).toBe('?');
    expect(avatarInitial({ displayName: '', email: '' })).toBe('?');
    expect(avatarInitial({})).toBe('?');
  });
  it('keeps a whole astral character', () => {
    expect(avatarInitial({ displayName: '\u{1F600} Grin' })).toBe('\u{1F600}');
  });
});

describe('avatarColour', () => {
  it('is stable for the same id and usually differs between ids', () => {
    expect(avatarColour('user-1')).toBe(avatarColour('user-1'));
    expect(avatarColour('user-1')).not.toBe(avatarColour('user-2'));
  });
  it('is an hsl() string', () => {
    expect(avatarColour('abc')).toMatch(/^hsl\(\d{1,3}, \d{1,3}%, \d{1,3}%\)$/);
    expect(avatarColour('')).toMatch(/^hsl\(/);
  });
  it('gives white text at least 4.5:1 contrast for every hue 0..359', () => {
    const lum = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    function hslToLum(h: number, s: number, l: number): number {
      const a = s * Math.min(l, 1 - l);
      const f = (n: number) => {
        const k = (n + h / 30) % 12;
        return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      };
      return 0.2126 * lum(f(0)) + 0.7152 * lum(f(8)) + 0.0722 * lum(f(4));
    }
    // Take the saturation/lightness the implementation really emits, then sweep every hue.
    const m = /^hsl\((\d+), (\d+)%, (\d+)%\)$/.exec(avatarColour('x'))!;
    for (let hue = 0; hue < 360; hue++) {
      const contrast = 1.05 / (hslToLum(hue, +m[2] / 100, +m[3] / 100) + 0.05);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('maps ids to hues within 0..359', () => {
    for (let id = 0; id < 500; id++) {
      const hue = +/^hsl\((\d+),/.exec(avatarColour(`id-${id}`))![1];
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

@Component({
  imports: [AvatarMenu],
  template: `
    <button id="outside" type="button">outside</button>
    <app-avatar-menu [closeRequested]="nav()" (signOut)="signedOut = signedOut + 1" />
  `,
})
class Host {
  nav = signal(0);
  signedOut = 0;
}

describe('AvatarMenu', () => {
  const user = signal<AuthUser | null>({ userId: 'u1', email: 'dev@example.com', displayName: 'Local Dev User' });
  let fixture: ComponentFixture<Host>;
  let host: Host;
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const btn = () => el().querySelector<HTMLButtonElement>('button.avatar-btn')!;
  const menu = () => el().querySelector<HTMLElement>('[role="menu"]');
  const popover = () => el().querySelector<HTMLElement>('.popover');
  const item = () => el().querySelector<HTMLButtonElement>('button[role="menuitem"]');

  async function settle() {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  async function open() {
    btn().click();
    await settle();
  }

  beforeEach(async () => {
    user.set({ userId: 'u1', email: 'dev@example.com', displayName: 'Local Dev User' });
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Auth, useValue: { user } }] });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    document.body.appendChild(el());
    await settle();
  });
  afterEach(() => el().remove());

  it('renders the initial with accessible button attributes, closed by default', () => {
    expect(btn().textContent.trim()).toBe('L');
    expect(btn().getAttribute('aria-label')).toBe('Account menu');
    expect(btn().getAttribute('aria-haspopup')).toBe('menu');
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(btn().style.backgroundColor).not.toBe('');
    expect(menu()).toBeNull();
  });

  it('renders ? with no user', async () => {
    user.set(null);
    await settle();
    expect(btn().textContent.trim()).toBe('?');
  });

  it('opens on click showing name, email and a Sign out menuitem, and moves focus into the menu', async () => {
    await open();
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    expect(menu()).not.toBeNull();
    expect(popover()!.textContent).toContain('Local Dev User');
    expect(popover()!.textContent).toContain('dev@example.com');
    expect(menu()!.textContent).not.toContain('dev@example.com');
    expect(menu()!.querySelectorAll('[role="menuitem"]').length).toBe(2);
    expect(menu()!.querySelector('a[role="menuitem"]')!.getAttribute('href')).toBe('/help');
    expect(menu()!.getAttribute('aria-labelledby')).toBe(btn().id);
    expect(btn().getAttribute('aria-controls')).toBe(menu()!.id);
    expect(item()!.textContent).toContain('Sign out');
    expect(document.activeElement).toBe(item());
  });

  it('toggles closed on a second click and returns focus to the button', async () => {
    await open();
    btn().click();
    await settle();
    expect(menu()).toBeNull();
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn());
  });

  it('closes on Escape and returns focus to the button', async () => {
    await open();
    item()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(btn());
  });

  it('moves between menu items with arrow keys, Home and End (wrapping), so Help is reachable', async () => {
    await open();
    const help = el().querySelector<HTMLElement>('a[role="menuitem"]')!;
    const key = (k: string) => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      (document.activeElement as HTMLElement).dispatchEvent(e);
      return e;
    };
    expect(document.activeElement).toBe(item());
    expect(key('ArrowUp').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(help);
    key('ArrowUp');
    expect(document.activeElement).toBe(item());
    key('ArrowDown');
    expect(document.activeElement).toBe(help);
    key('End');
    expect(document.activeElement).toBe(item());
    key('Home');
    expect(document.activeElement).toBe(help);
    expect(menu()).not.toBeNull();
  });

  it('closes on an outside click without stealing focus', async () => {
    await open();
    const outside = el().querySelector<HTMLButtonElement>('#outside')!;
    outside.focus();
    outside.click();
    await settle();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('does not close on a click inside the popover', async () => {
    await open();
    popover()!.click();
    await settle();
    expect(menu()).not.toBeNull();
    el().querySelector<HTMLElement>('.name')!.click();
    await settle();
    expect(menu()).not.toBeNull();
  });

  it('closes when Tab leaves the menu', async () => {
    await open();
    item()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    await settle();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(btn());
  });

  it('closes when closeRequested changes, on every change', async () => {
    await open();
    host.nav.set(1);
    await settle();
    expect(menu()).toBeNull();
    await open();
    host.nav.set(2);
    await settle();
    expect(menu()).toBeNull();
  });

  it('stays open when closeRequested is set to the same value', async () => {
    await open();
    host.nav.set(0);
    await settle();
    expect(menu()).not.toBeNull();
  });

  it('emits signOut and closes when Sign out is clicked', async () => {
    await open();
    item()!.click();
    await settle();
    expect(host.signedOut).toBe(1);
    expect(menu()).toBeNull();
  });

  it('only listens for document clicks while open', async () => {
    const add = jest.spyOn(document, 'addEventListener');
    const remove = jest.spyOn(document, 'removeEventListener');
    const clicks = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter((c) => c[0] === 'click').length;
    await open();
    expect(clicks(add)).toBe(1);
    btn().click();
    await settle();
    expect(clicks(remove)).toBe(1);
    add.mockRestore();
    remove.mockRestore();
  });

  it('works with an Auth that only exposes user (no other Auth calls)', async () => {
    await open();
    item()!.click();
    await settle();
    expect(host.signedOut).toBe(1);
  });

  it('handles long names and emails: full values are present in the popover', async () => {
    const longName = 'Bartholomew '.repeat(12).trim();
    const longEmail = `${'very.long.address'.repeat(8)}@example.com`;
    user.set({ userId: 'u2', email: longEmail, displayName: longName });
    await open();
    expect(popover()!.textContent).toContain(longName);
    expect(popover()!.textContent).toContain(longEmail);
  });
});

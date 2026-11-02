import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Auth } from '../../core/auth/auth';
import { Signin } from './signin';

function setup(signedOut: boolean) {
  const auth = {
    takeSignedOutFlag: () => signedOut,
    whenReady: () => Promise.resolve(),
    isAuthenticated: () => false,
    redirectToLogin: jest.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Auth, useValue: auth }] });
  const fixture = TestBed.createComponent(Signin);
  fixture.detectChanges();
  return { auth, fixture, el: fixture.nativeElement as HTMLElement };
}

describe('Signin', () => {
  it('auto-redirects to the Hosted UI on a normal visit', async () => {
    const { auth, fixture } = setup(false);
    await fixture.whenStable();
    expect(auth.redirectToLogin).toHaveBeenCalled();
  });

  it('after an explicit sign-out waits for a Sign in tap', async () => {
    const { auth, fixture, el } = setup(true);
    await fixture.whenStable();
    expect(auth.redirectToLogin).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('.signin-btn')?.click();
    await fixture.whenStable();
    expect(auth.redirectToLogin).toHaveBeenCalledTimes(1);
  });
});

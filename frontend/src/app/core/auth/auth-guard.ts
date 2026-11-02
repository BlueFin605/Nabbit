import { inject } from '@angular/core';
import { Router } from '@angular/router';
import type { CanActivateFn } from '@angular/router';
import { Auth } from './auth';

/**
 * Lets signed-in users through. Signed-out users are sent to /signin (which starts the Hosted UI redirect), and
 * the URL they wanted (including share-target query params on /import) is remembered for after sign-in.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(Auth);
  const router = inject(Router);
  await auth.whenReady();
  if (auth.isAuthenticated()) return true;
  auth.rememberReturnUrl(state.url);
  return router.createUrlTree(['/signin']);
};

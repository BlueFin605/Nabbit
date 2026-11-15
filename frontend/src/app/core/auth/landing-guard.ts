import { inject } from '@angular/core';
import { Router } from '@angular/router';
import type { CanActivateFn } from '@angular/router';
import { Auth } from './auth';

/** Guards the public landing page at `/`: signed-in users go straight to /recipes, visitors see the landing. */
export const landingGuard: CanActivateFn = async () => {
  const auth = inject(Auth);
  const router = inject(Router);
  await auth.whenReady();
  // Sign-out lands here; drop its flag so a later Sign in goes to the Hosted UI instead of "You have been signed out."
  auth.takeSignedOutFlag();
  return auth.isAuthenticated() ? router.createUrlTree(['/recipes']) : true;
};

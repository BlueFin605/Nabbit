import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Auth } from '../../core/auth/auth';

/** Cognito Hosted UI redirect target: exchanges the code (PKCE) for tokens, then returns to where the user was heading. */
@Component({
  selector: 'app-oauth-callback',
  imports: [MatButtonModule, MatProgressSpinnerModule],
  template: `
    <section class="center">
      @if (error()) {
        <h1>Sign in failed</h1>
        <p role="alert">{{ error() }}</p>
        <button mat-flat-button type="button" (click)="retry()">Try again</button>
      } @else {
        <mat-spinner diameter="40" />
        <p>Signing you in...</p>
      }
    </section>
  `,
  styles: `
    .center {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding-top: 20vh;
      text-align: center;
    }
  `,
})
export class OAuthCallback {
  private readonly auth = inject(Auth);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.complete();
  }

  private async complete(): Promise<void> {
    const params = this.route.snapshot.queryParamMap;
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      this.error.set(params.get('error_description') ?? 'Missing authorization code or state.');
      return;
    }
    try {
      await this.auth.completeOAuthCallback(code, state);
      await this.router.navigateByUrl(this.auth.takeReturnUrl(), { replaceUrl: true });
    } catch (err: unknown) {
      this.error.set(err instanceof Error ? err.message : 'Sign in failed');
    }
  }

  protected retry(): void {
    void this.router.navigate(['/signin'], { replaceUrl: true });
  }
}

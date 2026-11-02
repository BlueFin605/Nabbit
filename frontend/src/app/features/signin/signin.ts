import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Auth } from '../../core/auth/auth';

/** Starts the Cognito Hosted UI redirect for signed-out users (the auth guard sends them here). */
@Component({
  selector: 'app-signin',
  imports: [MatButtonModule, MatProgressSpinnerModule],
  template: `
    <section class="center">
      <h1>Nabbit</h1>
      @if (error()) {
        <p role="alert">{{ error() }}</p>
        <button mat-flat-button type="button" (click)="start()">Try again</button>
      } @else {
        <mat-spinner diameter="40" />
        <p>Taking you to sign in...</p>
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
export class Signin {
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.start();
  }

  protected async start(): Promise<void> {
    this.error.set(null);
    await this.auth.whenReady();
    if (this.auth.isAuthenticated()) {
      await this.router.navigateByUrl(this.auth.takeReturnUrl(), { replaceUrl: true });
      return;
    }
    try {
      await this.auth.redirectToLogin();
    } catch (err: unknown) {
      this.error.set(err instanceof Error ? err.message : 'Could not start sign-in');
    }
  }
}

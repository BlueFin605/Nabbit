import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AvatarMenu } from './core/shell/avatar-menu';
import { Auth } from './core/auth/auth';

const HIDE_NAV_ON = ['/signin', '/callback'];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, AvatarMenu],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly auth = inject(Auth);
  private readonly router = inject(Router);

  private readonly url = signal(this.router.url);
  /** Incremented on every NavigationEnd (even to the same URL); the avatar menu closes when it changes. */
  protected readonly navigations = signal(0);

  constructor() {
    this.router.events.pipe(takeUntilDestroyed()).subscribe((e) => {
      if (e instanceof NavigationEnd) {
        this.url.set(e.urlAfterRedirects);
        this.navigations.update((n) => n + 1);
      }
    });
  }

  protected readonly showNav = computed(
    () => this.auth.isAuthenticated() && !HIDE_NAV_ON.some((p) => this.url().startsWith(p)),
  );

  protected signOut(): void {
    if (!this.auth.logout()) void this.router.navigate(['/signin']);
  }
}

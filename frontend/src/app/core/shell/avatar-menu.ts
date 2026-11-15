import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { Auth } from '../auth/auth';

/** First letter (uppercased) of the display name, else the email, else '?'. */
export function avatarInitial(user: { displayName?: string; email?: string } | null): string {
  for (const source of [user?.displayName, user?.email]) {
    const first = Array.from((source ?? '').trim())[0];
    if (first) return first.toUpperCase();
  }
  return '?';
}

/**
 * Stable background for a user id: hue (0..359) from a string hash at fixed saturation and lightness.
 * Every hue satisfies >= 4.5:1 contrast for white text; the spec asserts this for all 360 hues.
 */
export function avatarColour(userId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${(hash >>> 0) % 360}, 55%, 28%)`;
}

let nextAvatarMenuId = 0;

/** Round avatar button with an account popover (name, email, Sign out). Sign out is an output; the shell decides what it does. */
@Component({
  selector: 'app-avatar-menu',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'onKeydown($event)' },
  styles: `
    :host { position: relative; display: inline-block; flex: none; }
    .avatar-btn {
      width: 48px; height: 48px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
      color: #fff; font-family: inherit; font-weight: 600; font-size: 1.125rem; line-height: 1;
      display: flex; align-items: center; justify-content: center;
    }
    /* Two-tone ring: white inner ring + dark outer outline, visible on both light and dark backgrounds. */
    .avatar-btn:focus-visible {
      outline: 3px solid #1b1b1f; outline-offset: 2px; box-shadow: 0 0 0 2px #fff;
    }
    .signout:focus-visible { outline: 3px solid #1b1b1f; outline-offset: -5px; box-shadow: inset 0 0 0 2px #fff; }
    .popover {
      position: absolute; right: 0; top: calc(100% + 4px); z-index: 1000;
      box-sizing: border-box; width: max-content; min-width: 220px; max-width: min(320px, calc(100vw - 32px));
      background: var(--mat-sys-surface-container, #fff); color: var(--mat-sys-on-surface, #1b1b1f);
      border-radius: 12px; box-shadow: 0 4px 16px rgb(0 0 0 / 0.25); padding: 8px 0;
    }
    .who { padding: 8px 16px 12px; }
    .name, .email { overflow-wrap: anywhere; }
    .name { font-weight: 600; }
    .email { font-size: 0.875rem; opacity: 0.8; }
    .signout {
      display: block; width: 100%; min-height: 48px; padding: 0 16px; border: 0; background: none;
      color: inherit; font: inherit; text-align: start; cursor: pointer;
    }
    .menu-item {
      box-sizing: border-box; display: flex; align-items: center; width: 100%; min-height: 48px; padding: 0 16px;
      color: inherit; font: inherit; text-decoration: none; cursor: pointer;
    }
    .menu-item:hover { background: rgb(128 128 128 / 0.15); }
    .menu-item:focus-visible { outline: 3px solid #1b1b1f; outline-offset: -5px; box-shadow: inset 0 0 0 2px #fff; }
    .signout:hover { background: rgb(128 128 128 / 0.15); }
  `,
  template: `
    <button
      #trigger
      [id]="triggerId"
      type="button"
      class="avatar-btn"
      aria-label="Account menu"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="open() ? menuId : null"
      [style.background-color]="colour()"
      (click)="toggle()"
    >
      <span aria-hidden="true">{{ initial() }}</span>
    </button>
    @if (open()) {
      <div class="popover">
        <div class="who">
          <div class="name">{{ auth.user()?.displayName }}</div>
          <div class="email">{{ auth.user()?.email }}</div>
        </div>
        <div role="menu" [id]="menuId" [attr.aria-labelledby]="triggerId">
          <a role="menuitem" class="menu-item help-link" routerLink="/help">Help</a>
          <button #signOutItem type="button" role="menuitem" class="signout" (click)="onSignOut()">Sign out</button>
        </div>
      </div>
    }
  `,
})
export class AvatarMenu {
  protected readonly auth = inject(Auth);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  private readonly uid = nextAvatarMenuId++;
  protected readonly triggerId = `avatar-menu-trigger-${this.uid}`;
  protected readonly menuId = `avatar-menu-${this.uid}`;

  /**
   * Closes the popover whenever the bound value changes. The shell must bind a value that changes on EVERY
   * navigation (a counter incremented on NavigationEnd, or the NavigationEnd event signal), not a constant.
   */
  readonly closeRequested = input<unknown>();
  readonly signOut = output<void>();

  protected readonly open = signal(false);
  protected readonly initial = computed(() => avatarInitial(this.auth.user()));
  protected readonly colour = computed(() => avatarColour(this.auth.user()?.userId ?? ''));

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly signOutItem = viewChild<ElementRef<HTMLButtonElement>>('signOutItem');

  constructor() {
    let first = true;
    effect(() => {
      this.closeRequested();
      if (first) {
        first = false;
        return;
      }
      this.open.set(false);
    });

    // Listen for outside clicks only while the popover is open.
    effect((onCleanup) => {
      if (!this.open()) return;
      const onDocumentClick = (event: MouseEvent) => {
        if (!event.composedPath().includes(this.host.nativeElement)) this.close(false);
      };
      document.addEventListener('click', onDocumentClick);
      onCleanup(() => document.removeEventListener('click', onDocumentClick));
    });
  }

  protected toggle(): void {
    if (this.open()) {
      this.close(true);
      return;
    }
    this.open.set(true);
    afterNextRender(() => this.signOutItem()?.nativeElement.focus(), { injector: this.injector });
  }

  private close(returnFocus: boolean): void {
    const wasOpen = this.open();
    this.open.set(false);
    if (wasOpen && returnFocus) this.trigger().nativeElement.focus();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (!this.open()) return;
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.close(true);
    } else if (event.key === 'Tab') {
      // Close and park focus on the button so the browser's Tab continues from there.
      this.close(true);
    }
  }

  protected onSignOut(): void {
    this.close(false);
    this.signOut.emit();
  }
}

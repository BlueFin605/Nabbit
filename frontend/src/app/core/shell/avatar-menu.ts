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
 * Stable background for a user id: hue from a string hash. Saturation 55% and lightness 28% keep white text
 * above 4.5:1 for every hue (worst case, green, is about 5.4:1; checked across all hues in the spec).
 */
export function avatarColour(userId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${(hash >>> 0) % 360}, 55%, 28%)`;
}

/** Round avatar button with an account popover (name, email, Sign out). Sign out is an output; the shell decides what it does. */
@Component({
  selector: 'app-avatar-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'onDocumentClick($event)' },
  styles: `
    :host { position: relative; display: inline-block; flex: none; }
    .avatar-btn {
      width: 48px; height: 48px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
      color: #fff; font: 600 1.125rem/1 inherit; display: flex; align-items: center; justify-content: center;
    }
    .avatar-btn:focus-visible, .signout:focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }
    .popover {
      position: absolute; right: 0; top: calc(100% + 4px); z-index: 1000;
      box-sizing: border-box; width: max-content; min-width: 220px; max-width: min(320px, calc(100vw - 32px));
      background: var(--mat-sys-surface-container, #fff); color: var(--mat-sys-on-surface, #1b1b1f);
      border-radius: 12px; outline: none; box-shadow: 0 4px 16px rgb(0 0 0 / 0.25); padding: 8px 0;
    }
    .who { padding: 8px 16px 12px; }
    .name, .email { overflow-wrap: anywhere; }
    .name { font-weight: 600; }
    .email { font-size: 0.875rem; opacity: 0.8; }
    .signout {
      display: block; width: 100%; min-height: 48px; padding: 0 16px; border: 0; background: none;
      color: inherit; font: inherit; text-align: start; cursor: pointer;
    }
    .signout:hover { background: rgb(128 128 128 / 0.15); }
  `,
  template: `
    <button
      #trigger
      type="button"
      class="avatar-btn"
      aria-label="Account menu"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [style.background-color]="colour()"
      (click)="toggle()"
    >
      <span aria-hidden="true">{{ initial() }}</span>
    </button>
    @if (open()) {
      <div class="popover" role="menu" tabindex="-1" aria-label="Account" (keydown)="onKeydown($event)">
        <div class="who" role="presentation">
          <div class="name">{{ auth.user()?.displayName }}</div>
          <div class="email">{{ auth.user()?.email }}</div>
        </div>
        <button #signOutItem type="button" role="menuitem" class="signout" (click)="onSignOut()">Sign out</button>
      </div>
    }
  `,
})
export class AvatarMenu {
  protected readonly auth = inject(Auth);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Change this value (e.g. on router navigation) to close the popover. */
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
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.close(true);
    } else if (event.key === 'Tab') {
      // Close and park focus on the button so the browser's Tab continues from there.
      this.close(true);
    }
  }

  protected onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.close(false);
  }

  protected onSignOut(): void {
    this.close(false);
    this.signOut.emit();
  }
}

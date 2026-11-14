import { Component, DestroyRef, inject, Injectable, InjectionToken } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatSnackBar, type MatSnackBarRef } from '@angular/material/snack-bar';
import { SwUpdate, type VersionEvent, type VersionReadyEvent } from '@angular/service-worker';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/** Reloads the page; a token so tests can replace it. */
export const RELOAD_PAGE = new InjectionToken<() => void>('RELOAD_PAGE', {
  providedIn: 'root',
  factory: () => () => location.reload(),
});

/** Content of the "new version" snackbar: a message plus Reload and Dismiss buttons. */
@Component({
  selector: 'app-update-prompt',
  template: `
    <span class="msg">A new version is available. Reloading discards unsaved edits.</span>
    <span class="actions">
      <button type="button" class="reload" (click)="reload()">Reload</button>
      <button type="button" class="dismiss" (click)="dismiss()">Dismiss</button>
    </span>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: space-between;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    button {
      min-height: 44px;
      padding: 0 12px;
      background: none;
      border: 0;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      color: inherit;
      text-transform: uppercase;
    }
    button:focus-visible {
      outline: 2px solid currentColor;
      outline-offset: 2px;
    }
  `,
})
export class UpdatePrompt {
  private readonly updates = inject(AppUpdates);
  protected reload(): void {
    void this.updates.reload();
  }
  protected dismiss(): void {
    this.updates.dismiss();
  }
}

/**
 * Tells an installed PWA that a newer build was deployed. Never reloads on its own (the user may be mid-edit):
 * it shows a persistent prompt on VERSION_READY. No-op when the service worker is absent or disabled (dev).
 *
 * MatSnackBar shows one snackbar at a time, so another one (e.g. Deleted/Undo) dismisses the prompt without the
 * user acting, and Angular emits VERSION_READY only once per version. `pending` therefore stays true until the user
 * clicks Reload or Dismiss, and the prompt is re-shown on the next navigation or return to the tab, but never on
 * top of a snackbar that is currently on screen.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdates {
  private readonly sw = inject(SwUpdate, { optional: true });
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);
  private readonly doReload = inject(RELOAD_PAGE);
  private readonly destroyRef = inject(DestroyRef);
  private started = false;
  private pending = false;
  private promptRef?: MatSnackBarRef<UpdatePrompt>;
  private checking = false;

  start(): void {
    const sw = this.sw;
    if (this.started || !sw || !sw.isEnabled) return;
    this.started = true;
    sw.versionUpdates
      .pipe(
        filter((e: VersionEvent): e is VersionReadyEvent => e.type === 'VERSION_READY'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.pending = true;
        this.show();
      });
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.show());
    this.check();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      this.check();
      this.show();
    };
    document.addEventListener('visibilitychange', onVisible);
    this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
  }

  async reload(): Promise<void> {
    this.pending = false;
    try {
      await this.sw?.activateUpdate();
    } catch {
      // still reload: a plain reload picks up the new version once it is active
    }
    this.doReload();
  }

  /** The user chose not to reload now: stay quiet until the next VERSION_READY. */
  dismiss(): void {
    this.pending = false;
    this.promptRef?.dismiss();
  }

  /** One check at a time, so repeated visibilitychange events cannot queue several. */
  private check(): void {
    if (this.checking || !this.sw) return;
    this.checking = true;
    this.sw
      .checkForUpdate()
      .catch(() => undefined)
      .finally(() => (this.checking = false));
  }

  private show(): void {
    if (!this.pending || this.promptRef) return;
    // _openedSnackBarRef is MatSnackBar's private handle on the snackbar on screen. There is no public way to
    // ask, and opening ours would dismiss an Undo, so defer until the next trigger when one is showing.
    const active = (this.snackBar as unknown as { _openedSnackBarRef?: unknown })._openedSnackBarRef;
    if (active) return;
    const ref = this.snackBar.openFromComponent(UpdatePrompt, { politeness: 'polite', panelClass: 'update-prompt' });
    this.promptRef = ref;
    ref.afterDismissed().subscribe(() => {
      if (this.promptRef === ref) this.promptRef = undefined;
    });
  }
}

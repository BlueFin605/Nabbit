import { Component, DestroyRef, inject, Injectable, InjectionToken } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatSnackBar, MatSnackBarRef } from '@angular/material/snack-bar';
import { SwUpdate, type VersionEvent, type VersionReadyEvent } from '@angular/service-worker';
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
    <span class="msg">A new version is available</span>
    <span class="actions">
      <button type="button" class="reload" (click)="reload()">Reload</button>
      <button type="button" class="dismiss" (click)="ref.dismiss()">Dismiss</button>
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
  `,
})
export class UpdatePrompt {
  protected readonly ref = inject(MatSnackBarRef<UpdatePrompt>);
  private readonly updates = inject(AppUpdates);
  protected reload(): void {
    void this.updates.reload();
  }
}

/**
 * Tells an installed PWA that a newer build was deployed. Never reloads on its own (the user may be mid-edit):
 * it shows a persistent prompt on VERSION_READY. No-op when the service worker is absent or disabled (dev).
 */
@Injectable({ providedIn: 'root' })
export class AppUpdates {
  private readonly sw = inject(SwUpdate, { optional: true });
  private readonly snackBar = inject(MatSnackBar);
  private readonly doReload = inject(RELOAD_PAGE);
  private readonly destroyRef = inject(DestroyRef);
  private started = false;
  private shown = false;

  start(): void {
    const sw = this.sw;
    if (this.started || !sw || !sw.isEnabled) return;
    this.started = true;
    sw.versionUpdates
      .pipe(
        filter((e: VersionEvent): e is VersionReadyEvent => e.type === 'VERSION_READY'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.show());
    const check = () => {
      sw.checkForUpdate().catch(() => undefined);
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    this.destroyRef.onDestroy(() => document.removeEventListener('visibilitychange', onVisible));
  }

  async reload(): Promise<void> {
    try {
      await this.sw?.activateUpdate();
    } catch {
      // still reload: a plain reload picks up the new version once it is active
    }
    this.doReload();
  }

  private show(): void {
    if (this.shown) return;
    this.shown = true;
    this.snackBar
      .openFromComponent(UpdatePrompt, { politeness: 'polite', panelClass: 'update-prompt' })
      .afterDismissed()
      .subscribe(() => (this.shown = false));
  }
}

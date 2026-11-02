import { Component, inject, input, signal, viewChild, type OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiClient } from '../../core/api/api-client';
import type { Recipe, RecipeInput } from '../../core/api/api.types';
import type { HasUnsavedChanges } from '../../core/guards/unsaved-changes-guard';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/confirm-dialog';
import { RecipeEditor, isVersionConflict } from './recipe-editor';

type Load = { status: 'loading' } | { status: 'notFound' } | { status: 'error' } | { status: 'ok'; recipe: Recipe };

/** Edit screen at /recipes/:id/edit: the shared editor plus save (with version), conflict handling and delete. */
@Component({
  selector: 'app-recipe-edit',
  imports: [RouterLink, MatButtonModule, RecipeEditor],
  styles: `
    :host { display: block; padding-bottom: 32px; }
    .delete { margin-left: auto; color: var(--mat-sys-error, #b3261e); }
  `,
  template: `
    @switch (load().status) {
      @case ('loading') {
        <p aria-busy="true">Loading…</p>
      }
      @case ('notFound') {
        <div class="state">
          <h1>Recipe not found</h1>
          <a routerLink="/recipes">Back to recipes</a>
        </div>
      }
      @case ('error') {
        <div class="state" role="alert">
          <p>Couldn't load this recipe.</p>
          <a routerLink="/recipes">Back to recipes</a>
        </div>
      }
      @default {
        @if (recipe(); as r) {
          <h1>Edit recipe</h1>
          <app-recipe-editor
            [recipe]="r"
            [saving]="saving()"
            [error]="error()"
            [conflict]="conflict()"
            cancelLabel="Cancel"
            (saved)="save($event)"
            (cancelled)="cancel()"
            (reload)="reload()"
          >
            <button mat-button type="button" class="delete" [disabled]="saving()" (click)="confirmDelete()">Delete</button>
          </app-recipe-editor>
        }
      }
    }
  `,
})
export class RecipeEdit implements OnInit, HasUnsavedChanges {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  /** Bound from the `:id` route param. */
  readonly id = input<string>();

  private readonly editor = viewChild(RecipeEditor);
  protected readonly load = signal<Load>({ status: 'loading' });
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly conflict = signal(false);
  /** Set once saved or deleted so the dirty guard lets the navigation through. */
  private leaving = false;

  protected recipe(): Recipe | null {
    const l = this.load();
    return l.status === 'ok' ? l.recipe : null;
  }

  ngOnInit(): void {
    this.fetch(false);
  }

  hasUnsavedChanges(): boolean {
    return !this.leaving && (this.editor()?.dirty() ?? false);
  }

  private fetch(isReload: boolean): void {
    const id = this.id();
    if (!id) {
      this.load.set({ status: 'notFound' });
      return;
    }
    this.api.getRecipe(id).subscribe({
      next: (recipe) => {
        if (recipe.deletedAt) {
          this.load.set({ status: 'notFound' });
          return;
        }
        this.conflict.set(false);
        this.error.set(null);
        this.load.set({ status: 'ok', recipe });
      },
      error: (err: { status?: number }) => {
        if (isReload) {
          this.error.set("Couldn't reload this recipe. Try again.");
          return;
        }
        this.load.set({ status: err?.status === 404 || err?.status === 410 ? 'notFound' : 'error' });
      },
    });
  }

  /** Discards the local edits and refetches the latest version (only on the user's explicit request). */
  protected reload(): void {
    this.fetch(true);
  }

  protected save(input: RecipeInput): void {
    const r = this.recipe();
    if (!r || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    this.api.updateRecipe(r.id, input, r.version).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.leaving = true;
        void this.router.navigate(['/recipes', updated.id]);
      },
      error: (err: unknown) => {
        this.saving.set(false);
        if (isVersionConflict(err)) this.conflict.set(true);
        else this.error.set("Couldn't save the recipe. Try again.");
      },
    });
  }

  protected cancel(): void {
    const id = this.recipe()?.id ?? this.id();
    void this.router.navigate(id ? ['/recipes', id] : ['/recipes']);
  }

  protected confirmDelete(): void {
    const r = this.recipe();
    if (!r) return;
    const data: ConfirmDialogData = {
      title: 'Delete this recipe?',
      message: `"${r.title}" will be deleted. You can undo this for a short while.`,
      confirmLabel: 'Delete',
    };
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, { data })
      .afterClosed()
      .subscribe((ok) => {
        if (ok === true) this.doDelete(r);
      });
  }

  private doDelete(r: Recipe): void {
    this.saving.set(true);
    this.api.deleteRecipe(r.id).subscribe({
      next: () => {
        this.saving.set(false);
        this.leaving = true;
        void this.router.navigate(['/recipes']);
        this.snackBar
          .open('Recipe deleted', 'Undo', { duration: 8000 })
          .onAction()
          .subscribe(() => this.undoDelete(r.id));
      },
      error: () => {
        this.saving.set(false);
        this.error.set("Couldn't delete the recipe. Try again.");
      },
    });
  }

  private undoDelete(id: string): void {
    this.api.restoreRecipe(id).subscribe({
      next: () => void this.router.navigate(['/recipes', id]),
      error: () => this.snackBar.open("Couldn't restore the recipe", undefined, { duration: 5000 }),
    });
  }
}

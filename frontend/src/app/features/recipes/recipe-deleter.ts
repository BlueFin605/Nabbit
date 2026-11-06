import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiClient } from '../../core/api/api-client';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/confirm-dialog';

export interface DeleteHooks {
  /** Runs after the API call succeeds (e.g. navigate away). */
  onDeleted?: () => void;
  /** Default: router.navigate(['/recipes', id]). */
  onRestored?: (id: string) => void;
  /** Default: snackbar with the message. */
  onError?: (message: string) => void;
}

/** Confirm -> soft delete -> Undo snackbar -> restore. Shared by the list, detail and edit screens. */
@Injectable({ providedIn: 'root' })
export class RecipeDeleter {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);

  confirmAndDelete(id: string, hooks: DeleteHooks = {}): void {
    const data: ConfirmDialogData = {
      title: 'Delete this recipe?',
      message: 'This recipe will be deleted. You can undo this for a short while.',
      confirmLabel: 'Delete',
    };
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, { data })
      .afterClosed()
      .subscribe((ok) => {
        if (ok === true) this.doDelete(id, hooks);
      });
  }

  private doDelete(id: string, hooks: DeleteHooks): void {
    this.api.deleteRecipe(id).subscribe({
      next: () => {
        hooks.onDeleted?.();
        this.snackBar
          .open('Recipe deleted', 'Undo', { duration: 8000 })
          .onAction()
          .subscribe(() => this.undo(id, hooks));
      },
      error: () => {
        const message = "Couldn't delete the recipe. Try again.";
        if (hooks.onError) hooks.onError(message);
        else this.snackBar.open(message, undefined, { duration: 5000 });
      },
    });
  }

  private undo(id: string, hooks: DeleteHooks): void {
    this.api.restoreRecipe(id).subscribe({
      next: () => (hooks.onRestored ? hooks.onRestored(id) : void this.router.navigate(['/recipes', id])),
      error: () => this.snackBar.open("Couldn't restore the recipe", undefined, { duration: 5000 }),
    });
  }
}

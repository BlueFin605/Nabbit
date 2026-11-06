import { inject } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { map } from 'rxjs';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/confirm-dialog';

export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
}

/** Asks before leaving a screen that has unsaved edits. */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = (component) => {
  if (!component.hasUnsavedChanges()) return true;
  const data: ConfirmDialogData = {
    title: 'Discard changes?',
    message: 'You have unsaved changes. If you leave now they will be lost.',
    confirmLabel: 'Discard',
    cancelLabel: 'Keep editing',
  };
  return inject(MatDialog)
    .open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, { data })
    .afterClosed()
    .pipe(map((ok) => ok === true));
};

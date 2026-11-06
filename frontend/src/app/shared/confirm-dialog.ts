import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

export interface ConfirmDialogData {
  title: string;
  message?: string;
  /** Optional detail rows (e.g. "before → after"). */
  lines?: string[];
  confirmLabel: string;
  cancelLabel?: string;
}

/** Generic confirm dialog: closes with `true` on confirm, `false` on cancel. */
@Component({
  selector: 'app-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule],
  styles: `
    ul { list-style: none; padding: 0; margin: 8px 0 0; }
    li { padding: 4px 0; }
  `,
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      @if (data.message) {
        <p>{{ data.message }}</p>
      }
      @if (data.lines?.length) {
        <ul class="lines">
          @for (l of data.lines; track $index) {
            <li>{{ l }}</li>
          }
        </ul>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" class="cancel" [mat-dialog-close]="false">{{ data.cancelLabel ?? 'Cancel' }}</button>
      <button mat-flat-button type="button" class="confirm" [mat-dialog-close]="true">{{ data.confirmLabel }}</button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialog {
  protected readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
}

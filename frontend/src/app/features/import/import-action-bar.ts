import { Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';

export type ImportMode = 'preview' | 'edit';

/** Save / Edit (Back to preview) / Discard buttons for the import page. Rendered twice (top and bottom) by the parent. */
@Component({
  selector: 'app-import-action-bar',
  imports: [MatButtonModule],
  styles: `
    :host { display: block; }
    .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 8px 0; }
  `,
  template: `
    <div class="bar">
      <button mat-flat-button type="button" class="save" [disabled]="saving()" (click)="save.emit()">Save</button>
      <button mat-stroked-button type="button" class="toggle-edit" [disabled]="saving()" (click)="edit.emit()">
        {{ mode() === 'edit' ? 'Back to preview' : 'Edit' }}
      </button>
      <button mat-button type="button" class="discard" [disabled]="saving()" (click)="discard.emit()">Discard</button>
    </div>
  `,
})
export class ImportActionBar {
  readonly mode = input<ImportMode>('preview');
  readonly saving = input(false);
  readonly save = output<void>();
  /** Toggles between preview and edit. */
  readonly edit = output<void>();
  readonly discard = output<void>();
}

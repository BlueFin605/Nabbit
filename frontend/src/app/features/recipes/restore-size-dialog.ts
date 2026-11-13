import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { formatQuantity, type Ingredient } from '@nabbit/recipe-core';

export interface RestoreSizeData {
  currentServings: number;
  originalServings: number;
  current: Ingredient[];
  original: Ingredient[];
  mode: 'metric' | 'original';
  /** True when the default scaling ingredient is not in the original and will be cleared. */
  clearsScaleBy?: boolean;
}

export interface CompareRow {
  id: string;
  name: string;
  current: string;
  original: string;
  changed: boolean;
}

export interface SizeComparison {
  /** Ingredients in both versions (matched by id), in the original's order. */
  rows: CompareRow[];
  /** In the current recipe but not the original: restoring removes them. */
  addedSince: Ingredient[];
  /** In the original but not the current recipe: restoring brings them back. */
  removedSince: Ingredient[];
}

/** Compares the current ingredients with the first-size backup by ingredient id. */
export function compareSizes(current: Ingredient[], original: Ingredient[], mode: 'metric' | 'original'): SizeComparison {
  const now = new Map(current.map((i) => [i.id, i]));
  const then = new Set(original.map((i) => i.id));
  const rows: CompareRow[] = [];
  const removedSince: Ingredient[] = [];
  for (const o of original) {
    const c = now.get(o.id);
    if (!c) {
      removedSince.push(o);
      continue;
    }
    const cur = formatQuantity(c, mode);
    const orig = formatQuantity(o, mode);
    rows.push({ id: o.id, name: o.name, current: cur, original: orig, changed: cur !== orig });
  }
  return { rows, addedSince: current.filter((i) => !then.has(i.id)), removedSince };
}

/** Restore-original-size comparison: closes with `true` to restore, `false` to cancel. */
@Component({
  selector: 'app-restore-size-dialog',
  imports: [MatDialogModule, MatButtonModule],
  styles: `
    ul { list-style: none; padding: 0; margin: 8px 0 0; }
    li { padding: 4px 0; }
    .tag { font-weight: 600; margin-right: 6px; }
    li.changed { border-left: 4px solid currentColor; padding-left: 8px; }
  `,
  template: `
    <h2 mat-dialog-title>Restore original size?</h2>
    <mat-dialog-content>
      <p class="warning">Restoring puts the recipe back to its first saved size, and any changes made since the first resize will be lost.</p>
      @if (data.clearsScaleBy) {
        <p class="scaleby-note">The default scaling ingredient will be cleared.</p>
      }
      <p class="servings">Servings: {{ data.currentServings }} → {{ data.originalServings }}</p>
      <ul class="compare" aria-label="Ingredients, current to original">
        @for (r of cmp.rows; track r.id) {
          <li [class.changed]="r.changed">
            @if (r.changed) {
              <span class="tag">Changed:</span>
              {{ r.current }} → {{ r.original }}
            } @else {
              {{ r.current }}
            }
          </li>
        }
      </ul>
      @if (cmp.removedSince.length) {
        <div class="removed">
          <p>Removed since, will come back:</p>
          <ul>
            @for (i of cmp.removedSince; track i.id) {
              <li>{{ i.name }}</li>
            }
          </ul>
        </div>
      }
      @if (cmp.addedSince.length) {
        <div class="added">
          <p>Added since, will be removed:</p>
          <ul>
            @for (i of cmp.addedSince; track i.id) {
              <li>{{ i.name }}</li>
            }
          </ul>
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" class="cancel" [mat-dialog-close]="false">Cancel</button>
      <button mat-flat-button type="button" class="confirm" [mat-dialog-close]="true">Restore original size</button>
    </mat-dialog-actions>
  `,
})
export class RestoreSizeDialog {
  protected readonly data = inject<RestoreSizeData>(MAT_DIALOG_DATA);
  protected readonly cmp = compareSizes(this.data.current, this.data.original, this.data.mode);
}

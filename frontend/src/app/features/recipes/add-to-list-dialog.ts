import { Component, computed, inject, signal, type OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { formatQuantity, type Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { ListSummary, NewListItem } from '../../core/api/api.types';
import { DEFAULT_LIST_NAME, LAST_LIST_KEY, ListTarget } from '../lists/list-target';

export { LAST_LIST_KEY, DEFAULT_LIST_NAME };

export interface AddToListData {
  /** Already scaled to the servings shown in the recipe view. */
  ingredients: Ingredient[];
  mode: 'metric' | 'original';
}

export interface AddToListResult {
  listId: string;
  listName: string;
  count: number;
}

/**
 * The list item name for an ingredient: the bare name, plus the scaled quantity text in a suffix
 * only when there is one, e.g. "flour (480 ml)". Category is left to the server's item memory.
 * Quantity text comes from recipe-core's formatQuantity with the name blanked, so scaling and
 * unit formatting are not reimplemented here.
 */
export function listItemName(i: Ingredient, mode: 'metric' | 'original'): string {
  const raw = i.quantity === null ? '' : formatQuantity({ ...i, name: '', scalable: true }, mode).trim();
  const qty = raw === 'a pinch of' ? 'a pinch' : raw;
  return qty ? `${i.name} (${qty})` : i.name;
}

/** Pick a list and tick the (scaled) ingredients to add; one batch POST on confirm. */
@Component({
  selector: 'app-add-to-list-dialog',
  imports: [MatDialogModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatSelectModule],
  styles: `
    mat-form-field { width: 100%; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { min-height: 44px; display: flex; align-items: center; }
    .error { color: var(--mat-sys-error, #b3261e); }
  `,
  template: `
    <h2 mat-dialog-title>Add to list</h2>
    <mat-dialog-content>
      @if (status() === 'loading') {
        <p aria-busy="true">Loading…</p>
      } @else if (status() === 'error') {
        <p class="error" role="alert">Couldn't load your lists.</p>
      } @else {
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>List</mat-label>
          <mat-select class="list-pick" [value]="listId()" (selectionChange)="listId.set($event.value)">
            @for (l of lists(); track l.id) {
              <mat-option [value]="l.id">{{ l.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <ul class="rows">
          @for (r of rows(); track r.id) {
            <li>
              <mat-checkbox class="row" [checked]="r.ticked" (change)="toggle(r.id, $event.checked)">{{ r.label }}</mat-checkbox>
            </li>
          }
        </ul>
      }
      @if (error(); as e) {
        <p class="error" role="alert">{{ e }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" class="cancel" [mat-dialog-close]="undefined">Cancel</button>
      <button mat-flat-button type="button" class="confirm" [disabled]="!canConfirm()" (click)="confirm()">
        Add {{ tickedCount() }} {{ tickedCount() === 1 ? 'item' : 'items' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class AddToListDialog implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly target = inject(ListTarget);
  private readonly ref = inject<MatDialogRef<AddToListDialog, AddToListResult>>(MatDialogRef);
  private readonly data = inject<AddToListData>(MAT_DIALOG_DATA);

  protected readonly status = signal<'loading' | 'error' | 'ok'>('loading');
  protected readonly lists = signal<ListSummary[]>([]);
  protected readonly listId = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Ingredient ids the user has unticked; to-taste (no quantity) rows start unticked. */
  private readonly off = signal<Set<string>>(
    new Set(this.data.ingredients.filter((i) => !i.scalable && i.quantity === null).map((i) => i.id)),
  );

  protected readonly rows = computed(() =>
    this.data.ingredients.map((i) => ({
      id: i.id,
      name: listItemName(i, this.data.mode),
      label: formatQuantity(i, this.data.mode),
      ticked: !this.off().has(i.id),
    })),
  );
  protected readonly tickedCount = computed(() => this.rows().filter((r) => r.ticked).length);
  protected readonly canConfirm = computed(
    () => this.status() === 'ok' && !!this.listId() && this.tickedCount() > 0 && !this.saving(),
  );

  ngOnInit(): void {
    this.api.listLists().subscribe({
      next: (rows) => {
        if (rows.length === 0) {
          this.api.createList(DEFAULT_LIST_NAME).subscribe({
            next: (l) => this.ready([{ id: l.id, name: l.name, itemCount: 0, version: l.version, updatedAt: l.updatedAt }]),
            error: () => this.status.set('error'),
          });
          return;
        }
        this.ready(rows);
      },
      error: () => this.status.set('error'),
    });
  }

  private ready(rows: ListSummary[]): void {
    this.lists.set(rows);
    const last = this.target.readLast();
    this.listId.set((rows.find((r) => r.id === last) ?? rows.find((r) => r.name === DEFAULT_LIST_NAME) ?? rows[0]).id);
    this.status.set('ok');
  }

  protected toggle(id: string, on: boolean): void {
    this.off.update((s) => {
      const next = new Set(s);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected confirm(): void {
    const listId = this.listId();
    if (!listId || !this.canConfirm()) return;
    const items: NewListItem[] = this.rows()
      .filter((r) => r.ticked)
      .map((r) => ({ name: r.name }));
    this.saving.set(true);
    this.error.set(null);
    this.api.addItems(listId, items).subscribe({
      next: (list) => {
        this.target.remember(listId);
        this.ref.close({ listId, listName: list.name, count: items.length });
      },
      error: () => {
        this.saving.set(false);
        this.error.set("Couldn't add these to the list. Try again.");
      },
    });
  }
}

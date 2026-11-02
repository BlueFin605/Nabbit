import { Component, computed, inject, signal, viewChild, type ElementRef, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import {
  MatAutocompleteModule,
  MatAutocompleteTrigger,
  type MatAutocompleteSelectedEvent,
} from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CATEGORIES, type ListItem } from '@nabbit/recipe-core';
import { Observable, Subject, catchError, debounceTime, of, retry, switchMap, throwError } from 'rxjs';
import { ApiClient } from '../../core/api/api-client';
import type { ItemSuggestion, ListSummary, ShoppingList } from '../../core/api/api.types';
import { ConfirmDialog } from '../../shared/confirm-dialog';

export const SUGGEST_DEBOUNCE_MS = 250;
export const DOUBLE_TAP_MS = 300;
export const LONG_PRESS_MS = 500;
export const UNDO_MS = 5000;
export const DEFAULT_LIST_NAME = 'Shopping';

/** Dialog for picking a category (long-press on an item). Closes with the chosen category. */
@Component({
  selector: 'app-category-dialog',
  imports: [MatDialogModule, MatButtonModule],
  styles: `
    .cats { display: flex; flex-direction: column; gap: 4px; }
    button { min-height: 48px; justify-content: flex-start; }
  `,
  template: `
    <h2 mat-dialog-title>Move to aisle</h2>
    <mat-dialog-content>
      <div class="cats">
        @for (c of categories; track c) {
          <button mat-button type="button" class="cat" [mat-dialog-close]="c">{{ c }}</button>
        }
      </div>
    </mat-dialog-content>
  `,
})
export class CategoryDialog {
  protected readonly categories = CATEGORIES;
}

interface Group {
  category: string;
  items: ListItem[];
}

const isConflict = (e: unknown): boolean => e instanceof HttpErrorResponse && e.status === 409;

/** Shopping lists: aisles-grouped items, tap to check, double-tap to delete, quick add with autocomplete. */
@Component({
  selector: 'app-lists',
  imports: [MatAutocompleteModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  styles: `
    :host { display: block; padding-bottom: 32px; }
    .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
    .bar button { min-height: 44px; }
    .bar button.current { font-weight: 600; }
    .name-form { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .name-form mat-form-field { flex: 1; }
    .quick { position: sticky; top: 0; z-index: 2; background: var(--mat-sys-surface, #fff); padding: 8px 0; }
    .quick mat-form-field { width: 100%; }
    h2.aisle { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; margin: 16px 0 4px; opacity: 0.7; }
    ul { list-style: none; margin: 0; padding: 0; }
    .item {
      display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; padding: 8px 12px;
      border: 0; border-bottom: 1px solid rgba(128, 128, 128, 0.25); background: transparent; color: inherit;
      font: inherit; font-size: 1.1rem; text-align: left; cursor: pointer; user-select: none;
      -webkit-user-select: none; touch-action: manipulation; -webkit-touch-callout: none;
    }
    .item .box { width: 24px; height: 24px; border: 2px solid currentColor; border-radius: 6px; flex: none; text-align: center; line-height: 20px; }
    .item.checked { opacity: 0.55; text-decoration: line-through; }
    .state { text-align: center; padding: 32px 0; }
    .sug-cat { margin-left: 8px; opacity: 0.6; font-size: 0.8rem; }
  `,
  template: `
    <h1>Lists</h1>

    @if (status() === 'loading') {
      <p class="state" aria-busy="true">Loading…</p>
    } @else if (status() === 'error') {
      <div class="state" role="alert">
        <p>Couldn't load your lists.</p>
        <button mat-flat-button type="button" class="retry" (click)="init()">Retry</button>
      </div>
    } @else {
      <div class="bar" role="toolbar" aria-label="Lists">
        @for (l of summaries(); track l.id) {
          <button mat-stroked-button type="button" class="pick" [class.current]="l.id === list()?.id" (click)="open(l.id)">
            {{ l.name }}
          </button>
        }
        <button mat-button type="button" class="new" (click)="startNameEdit('new')">+ New list</button>
        @if (list()) {
          <button mat-button type="button" class="rename" (click)="startNameEdit('rename')">Rename</button>
          <button mat-button type="button" class="delete-list" (click)="removeList()">Delete list</button>
        }
      </div>

      @if (nameMode()) {
        <form class="name-form" (submit)="$event.preventDefault(); saveName()">
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>{{ nameMode() === 'new' ? 'New list name' : 'List name' }}</mat-label>
            <input matInput class="name-input" [value]="nameDraft()" (input)="onNameInput($event)" />
          </mat-form-field>
          <button mat-flat-button type="submit" class="save-name">Save</button>
          <button mat-button type="button" (click)="nameMode.set(null)">Cancel</button>
        </form>
      }

      @if (list(); as l) {
        <div class="quick">
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Add item</mat-label>
            <input
              #quick
              matInput
              class="quick-add"
              autocomplete="off"
              enterkeyhint="done"
              [matAutocomplete]="auto"
              [value]="draft()"
              (input)="onDraft($event)"
              (keydown.enter)="onEnter($event)"
            />
            <mat-autocomplete #auto="matAutocomplete" [displayWith]="blank" (optionSelected)="onPick($event)">
              @for (s of suggestions(); track s.name) {
                <mat-option [value]="s">{{ s.name }}<span class="sug-cat">{{ s.category }}</span></mat-option>
              }
            </mat-autocomplete>
          </mat-form-field>
        </div>

        @if (l.items.length === 0) {
          <p class="state empty">Nothing on this list yet</p>
        }
        @for (g of groups(); track g.category) {
          <section class="aisle-group">
            <h2 class="aisle">{{ g.category }}</h2>
            <ul>
              @for (it of g.items; track it.id) {
                <li>
                  <button
                    type="button"
                    class="item"
                    role="checkbox"
                    [class.checked]="it.checked"
                    [attr.aria-checked]="it.checked"
                    (click)="onTap(it)"
                    (pointerdown)="pressStart(it)"
                    (pointerup)="pressEnd()"
                    (pointerleave)="pressEnd()"
                    (pointercancel)="pressEnd()"
                    (contextmenu)="$event.preventDefault()"
                  >
                    <span class="box" aria-hidden="true">{{ it.checked ? '✓' : '' }}</span>
                    <span class="label">{{ it.name }}</span>
                  </button>
                </li>
              }
            </ul>
          </section>
        }
      }
    }
  `,
})
export class Lists implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly quick = viewChild<ElementRef<HTMLInputElement>>('quick');
  private readonly trigger = viewChild(MatAutocompleteTrigger);

  protected readonly status = signal<'loading' | 'error' | 'ok'>('loading');
  protected readonly summaries = signal<ListSummary[]>([]);
  protected readonly list = signal<ShoppingList | null>(null);
  protected readonly suggestions = signal<ItemSuggestion[]>([]);
  protected readonly draft = signal('');
  protected readonly nameMode = signal<'new' | 'rename' | null>(null);
  protected readonly nameDraft = signal('');

  /** Items grouped by aisle in CATEGORIES order (unknown categories last); unchecked first, checked struck to the bottom. */
  protected readonly groups = computed<Group[]>(() => {
    const items = this.list()?.items ?? [];
    const known: readonly string[] = CATEGORIES;
    const extra = [...new Set(items.map((i) => i.category).filter((c) => !known.includes(c)))];
    return [...known, ...extra]
      .map((category) => {
        const inCat = items.filter((i) => i.category === category);
        return { category, items: [...inCat.filter((i) => !i.checked), ...inCat.filter((i) => i.checked)] };
      })
      .filter((g) => g.items.length > 0);
  });

  private readonly suggest$ = new Subject<string>();
  private lastTap: { id: string; at: number } | null = null;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressed = false;
  private inflight = 0;
  private tmp = 0;

  protected readonly blank = (): string => '';

  constructor() {
    this.suggest$
      .pipe(
        debounceTime(SUGGEST_DEBOUNCE_MS),
        switchMap((q) =>
          q ? this.api.suggestItems(q).pipe(catchError(() => of<ItemSuggestion[]>([]))) : of<ItemSuggestion[]>([]),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((s) => this.suggestions.set(s));
  }

  ngOnInit(): void {
    this.init();
  }

  protected init(): void {
    this.status.set('loading');
    this.api.listLists().subscribe({
      next: (rows) => {
        if (rows.length === 0) {
          this.api.createList(DEFAULT_LIST_NAME).subscribe({
            next: (created) => {
              this.summaries.set([this.summary(created)]);
              this.list.set(created);
              this.status.set('ok');
            },
            error: () => this.status.set('error'),
          });
          return;
        }
        this.summaries.set(rows);
        this.status.set('ok');
        this.open((rows.find((r) => r.name === DEFAULT_LIST_NAME) ?? rows[0]).id);
      },
      error: () => this.status.set('error'),
    });
  }

  protected open(id: string): void {
    this.api.getList(id).subscribe({
      next: (l) => this.list.set(l),
      error: () => this.fail("Couldn't open that list"),
    });
  }

  // ---- list management ----

  protected startNameEdit(mode: 'new' | 'rename'): void {
    this.nameDraft.set(mode === 'rename' ? (this.list()?.name ?? '') : '');
    this.nameMode.set(mode);
  }

  protected onNameInput(event: Event): void {
    this.nameDraft.set((event.target as HTMLInputElement).value);
  }

  protected saveName(): void {
    const name = this.nameDraft().trim();
    const mode = this.nameMode();
    if (!name || !mode) return;
    if (mode === 'new') {
      this.api.createList(name).subscribe({
        next: (created) => {
          this.summaries.update((s) => [...s, this.summary(created)]);
          this.list.set(created);
          this.nameMode.set(null);
        },
        error: () => this.fail("Couldn't create the list"),
      });
      return;
    }
    const current = this.list();
    if (!current) return;
    const id = current.id;
    const put = (base: ShoppingList) => this.api.replaceList({ id, name, items: base.items, version: base.version });
    // 409: refetch the latest list and re-apply the rename quietly.
    put(current)
      .pipe(
        catchError((e: unknown) =>
          isConflict(e) ? this.api.getList(id).pipe(switchMap((fresh) => put(fresh))) : throwError(() => e),
        ),
      )
      .subscribe({
        next: (saved) => {
          this.list.set(saved);
          this.summaries.update((s) => s.map((r) => (r.id === id ? this.summary(saved) : r)));
          this.nameMode.set(null);
        },
        error: () => this.fail("Couldn't rename the list"),
      });
  }

  protected removeList(): void {
    const current = this.list();
    if (!current) return;
    this.dialog
      .open(ConfirmDialog, {
        data: { title: `Delete "${current.name}"?`, message: 'The list and its items will be removed.', confirmLabel: 'Delete' },
      })
      .afterClosed()
      .subscribe((ok) => {
        if (!ok) return;
        this.api.deleteList(current.id).subscribe({
          next: () => {
            const rest = this.summaries().filter((r) => r.id !== current.id);
            this.summaries.set(rest);
            this.list.set(null);
            if (rest.length > 0) this.open(rest[0].id);
            else this.init();
          },
          error: () => this.fail("Couldn't delete the list"),
        });
      });
  }

  // ---- item gestures ----

  protected onTap(item: ListItem): void {
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    const now = Date.now();
    const last = this.lastTap;
    if (last && last.id === item.id && now - last.at <= DOUBLE_TAP_MS) {
      // Second tap of a double-tap: no toggle; the first tap's check goes away with the item.
      this.lastTap = null;
      this.remove(item);
      return;
    }
    this.lastTap = { id: item.id, at: now };
    this.toggle(item);
  }

  protected pressStart(item: ListItem): void {
    this.pressEnd();
    this.pressTimer = setTimeout(() => {
      this.pressTimer = null;
      this.longPressed = true;
      this.lastTap = null;
      this.chooseCategory(item);
    }, LONG_PRESS_MS);
  }

  protected pressEnd(): void {
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
  }

  private toggle(item: ListItem): void {
    const listId = this.list()?.id;
    if (!listId) return;
    const prev = item.checked;
    this.patchLocal(item.id, { checked: !prev });
    this.run(() => this.api.patchItem(listId, item.id, { checked: !prev })).subscribe({
      next: (res) => this.bumpVersion(res),
      error: () => {
        this.patchLocal(item.id, { checked: prev });
        this.fail("Couldn't update that item");
      },
    });
  }

  private remove(item: ListItem): void {
    const current = this.list();
    if (!current) return;
    const index = current.items.findIndex((i) => i.id === item.id);
    if (index < 0) return;
    const gone = current.items[index];
    this.setItems(current.items.filter((i) => i.id !== item.id));
    this.snack
      .open('Deleted', 'Undo', { duration: UNDO_MS })
      .onAction()
      .subscribe(() => this.addItem(gone.name, gone.category));
    this.run(() => this.api.deleteItem(current.id, item.id)).subscribe({
      next: (res) => this.bumpVersion(res),
      error: () => {
        this.setItems(this.insertAt(this.list()?.items ?? [], gone, index));
        this.fail("Couldn't delete that item");
      },
    });
  }

  private chooseCategory(item: ListItem): void {
    this.dialog
      .open(CategoryDialog)
      .afterClosed()
      .subscribe((category: string | undefined) => {
        const listId = this.list()?.id;
        if (!category || !listId || category === item.category) return;
        const prev = item.category;
        this.patchLocal(item.id, { category });
        this.run(() => this.api.patchItem(listId, item.id, { category })).subscribe({
          next: (res) => this.bumpVersion(res),
          error: () => {
            this.patchLocal(item.id, { category: prev });
            this.fail("Couldn't change the aisle");
          },
        });
      });
  }

  // ---- quick add ----

  protected onDraft(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.draft.set(value);
    this.suggest$.next(value.trim());
  }

  protected onEnter(event: Event): void {
    event.preventDefault();
    if (this.trigger()?.activeOption) return; // the autocomplete selects it
    const name = this.draft().trim();
    if (!name) return;
    const match = this.suggestions().find((s) => s.name.toLowerCase() === name.toLowerCase());
    this.commitDraft(name, match?.category);
  }

  protected onPick(event: MatAutocompleteSelectedEvent): void {
    const s = event.option.value as ItemSuggestion;
    this.commitDraft(s.name, s.category);
  }

  private commitDraft(name: string, category?: string): void {
    this.draft.set('');
    this.suggestions.set([]);
    this.suggest$.next('');
    const input = this.quick()?.nativeElement;
    if (input) {
      input.value = '';
      input.focus();
    }
    this.addItem(name, category);
  }

  private addItem(name: string, category?: string): void {
    const current = this.list();
    if (!current) return;
    const trimmed = name.trim();
    const dup = current.items.some((i) => !i.checked && i.name.toLowerCase() === trimmed.toLowerCase());
    const tempId = `tmp-${++this.tmp}`;
    // The server merges an unchecked duplicate, so only show a new row when it is genuinely new.
    if (!dup) this.setItems([...current.items, { id: tempId, name: trimmed, category: category ?? 'Other', checked: false }]);
    this.run(() => this.api.addItems(current.id, [{ name: trimmed, ...(category ? { category } : {}) }])).subscribe({
      next: (res) => {
        if (this.inflight === 0) {
          this.list.set(res);
          return;
        }
        // Other edits are still in flight: swap only the temp row for the server's.
        const have = new Set((this.list()?.items ?? []).map((i) => i.id));
        const real = res.items.find((i) => !have.has(i.id) && i.name.toLowerCase() === trimmed.toLowerCase());
        const items = (this.list()?.items ?? []).flatMap((i) => (i.id !== tempId ? [i] : real ? [real] : []));
        this.list.update((l) => (l ? { ...l, items, version: res.version } : l));
      },
      error: () => {
        this.setItems((this.list()?.items ?? []).filter((i) => i.id !== tempId));
        this.fail(`Couldn't add ${trimmed}`);
      },
    });
  }

  // ---- helpers ----

  /** Counts a request as in flight and retries once on a 409 (stale version). */
  private run<T>(make: () => Observable<T>): Observable<T> {
    this.inflight++;
    return new Observable<T>((sub) => {
      const s = make()
        .pipe(retry({ count: 1, delay: (e: unknown): Observable<unknown> => (isConflict(e) ? of(0) : throwError(() => e)) }))
        .subscribe({
          next: (v) => sub.next(v),
          error: (e: unknown) => {
            this.inflight--;
            sub.error(e);
          },
          complete: () => {
            this.inflight--;
            sub.complete();
          },
        });
      return () => s.unsubscribe();
    });
  }

  private summary(l: ShoppingList): ListSummary {
    return { id: l.id, name: l.name, itemCount: l.items.length, version: l.version, updatedAt: l.updatedAt };
  }

  private setItems(items: ListItem[]): void {
    this.list.update((l) => (l ? { ...l, items } : l));
  }

  private patchLocal(id: string, patch: Partial<ListItem>): void {
    this.list.update((l) => (l ? { ...l, items: l.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) } : l));
  }

  private bumpVersion(res: ShoppingList): void {
    this.list.update((l) => (l && res.version > l.version ? { ...l, version: res.version } : l));
  }

  private insertAt(items: ListItem[], item: ListItem, index: number): ListItem[] {
    const next = [...items];
    next.splice(Math.min(index, next.length), 0, item);
    return next;
  }

  private fail(message: string): void {
    this.snack.open(message, 'OK', { duration: UNDO_MS });
  }
}

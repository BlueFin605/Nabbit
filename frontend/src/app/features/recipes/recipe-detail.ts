import { Component, DestroyRef, computed, inject, input, signal, type OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { map, switchMap } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { convertTemperatures, formatQuantity, scaleRecipeIngredients, type Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { Recipe, RecipeInput } from '../../core/api/api.types';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/confirm-dialog';
import { CONFLICT_MESSAGE, isVersionConflict } from './recipe-editor';
import { imageUrl } from '../../core/api/image-url';
import { RecipeDeleter } from './recipe-deleter';
import { AddToListDialog, listItemName, type AddToListData, type AddToListResult } from './add-to-list-dialog';
import { ListTarget } from '../lists/list-target';

export const UNIT_MODE_KEY = 'nabbit.unitMode';
export const MIN_SERVINGS = 1;
export const MAX_SERVINGS = 99;

type Mode = 'metric' | 'original';
type Load = { status: 'loading' } | { status: 'notFound' } | { status: 'error' } | { status: 'ok'; recipe: Recipe };

interface WakeLockSentinelLike {
  release(): Promise<void>;
}
type WakeLockNav = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };

function readMode(): Mode {
  try {
    return localStorage.getItem(UNIT_MODE_KEY) === 'original' ? 'original' : 'metric';
  } catch {
    return 'metric';
  }
}

/** Single recipe view: scaled ingredients, steps, unit toggle and keep-awake. Scaling is client-side only. */
@Component({
  selector: 'app-recipe-detail',
  imports: [RouterLink, MatButtonModule, MatButtonToggleModule, MatSlideToggleModule],
  styleUrl: './recipe-detail.scss',
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
          <a routerLink="/recipes">Back to recipes</a>
          @if (r.imageKey) {
            <img class="photo" [src]="imageSrc(r.imageKey)" alt="" />
          }
          <h1>{{ r.title }}</h1>

          <div class="controls">
            <div class="stepper" role="group" aria-label="Servings">
              <button mat-stroked-button type="button" aria-label="Fewer servings" [disabled]="servings() <= min" (click)="step(-1)">−</button>
              <output aria-live="polite">{{ servings() }}</output>
              <button mat-stroked-button type="button" aria-label="More servings" [disabled]="servings() >= max" (click)="step(1)">+</button>
              <span>servings</span>
            </div>

            <mat-button-toggle-group aria-label="Units" [value]="mode()" (change)="setMode($event.value)">
              <mat-button-toggle value="metric">Metric</mat-button-toggle>
              <mat-button-toggle value="original">Original</mat-button-toggle>
            </mat-button-toggle-group>

            @if (wakeSupported) {
              <mat-slide-toggle class="wake" [checked]="awake()" (change)="toggleAwake($event.checked)">
                Keep screen awake
              </mat-slide-toggle>
            }
          </div>

          @if (resized()) {
            <div class="resize">
              <button mat-flat-button type="button" class="save-size" [disabled]="savingSize()" (click)="confirmResize()">
                Save as new size ({{ servings() }} servings)
              </button>
            </div>
          }
          @if (conflict()) {
            <div class="conflict" role="alert">
              <span>{{ conflictMessage }}</span>
              <button mat-flat-button type="button" class="reload" (click)="reload()">Reload</button>
            </div>
          }
          @if (sizeError(); as e) {
            <p class="size-error" role="alert">{{ e }}</p>
          }

          <h2>Ingredients</h2>
          <ul class="ingredients">
            @for (line of lines(); track line.id) {
              <li [class.fixed]="line.fixed">
                <span class="qty">{{ line.text }}</span>
                @if (line.note) {
                  <span class="note">, {{ line.note }}</span>
                }
                <button
                  mat-icon-button
                  type="button"
                  class="add-one"
                  [attr.aria-label]="'Add ' + line.name + ' to shopping list'"
                  (click)="addOne(line.id)"
                >
                  <span aria-hidden="true">{{ added().has(line.id) ? '✓' : '+' }}</span>
                </button>
              </li>
            }
          </ul>

          <h2>Steps</h2>
          <ol class="steps">
            @for (s of steps(); track $index) {
              <li>{{ s }}</li>
            }
          </ol>

          @if (r.sourceUrl) {
            <p class="source"><a [href]="r.sourceUrl" target="_blank" rel="noopener noreferrer">Source</a></p>
          }

          <div class="actions">
            <a mat-stroked-button [routerLink]="['/recipes', r.id, 'edit']">Edit</a>
            <button mat-flat-button type="button" (click)="addToList()">Add to list</button>
            <button mat-button type="button" class="delete" (click)="remove()">Delete</button>
          </div>
        }
      }
    }
  `,
})
export class RecipeDetail implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly router = inject(Router);
  private readonly deleter = inject(RecipeDeleter);
  private readonly listTarget = inject(ListTarget);

  /** Bound from the `:id` route param via withComponentInputBinding. */
  readonly id = input<string>();

  protected readonly conflictMessage = CONFLICT_MESSAGE;
  protected readonly savingSize = signal(false);
  protected readonly conflict = signal(false);
  protected readonly sizeError = signal<string | null>(null);
  protected readonly min = MIN_SERVINGS;
  protected readonly max = MAX_SERVINGS;
  protected readonly load = signal<Load>({ status: 'loading' });
  protected readonly mode = signal<Mode>(readMode());
  /** Ingredient ids added to the list since servings or units last changed. */
  protected readonly added = signal<ReadonlySet<string>>(new Set());
  private readonly adding = new Set<string>();
  /** null until the user touches the stepper; then overrides the recipe's stored servings. */
  private readonly chosen = signal<number | null>(null);

  protected readonly recipe = computed(() => {
    const l = this.load();
    return l.status === 'ok' ? l.recipe : null;
  });
  protected readonly servings = computed(() => this.chosen() ?? this.recipe()?.servings ?? 1);

  /** The stored ingredients scaled to the chosen servings (a new array; the recipe is untouched). */
  readonly scaledIngredients = computed<Ingredient[]>(() => {
    const r = this.recipe();
    if (!r) return [];
    return scaleRecipeIngredients(r.ingredients, r.servings, this.servings());
  });

  /** The stepper differs from the stored servings. */
  protected readonly resized = computed(() => {
    const r = this.recipe();
    return !!r && this.servings() !== r.servings;
  });

  protected readonly lines = computed(() =>
    this.scaledIngredients().map((i) => ({
      id: i.id,
      name: i.name,
      text: formatQuantity(i, this.mode()),
      note: i.note,
      fixed: !i.scalable,
    })),
  );
  protected readonly steps = computed(() => {
    const r = this.recipe();
    if (!r) return [];
    return this.mode() === 'metric' ? r.steps.map(convertTemperatures) : r.steps;
  });

  protected readonly wakeSupported = typeof navigator !== 'undefined' && !!(navigator as WakeLockNav).wakeLock;
  protected readonly awake = signal(false);
  private sentinel: WakeLockSentinelLike | null = null;
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') {
      if (this.awake() && !this.sentinel) void this.acquire();
    } else {
      void this.release();
    }
  };

  constructor() {
    document.addEventListener('visibilitychange', this.onVisibility);
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('visibilitychange', this.onVisibility);
      void this.release();
    });
  }

  ngOnInit(): void {
    this.fetch();
  }

  /** Refetches after a version conflict; drops the unsaved size change. */
  protected reload(): void {
    this.conflict.set(false);
    this.sizeError.set(null);
    this.chosen.set(null);
    this.fetch();
  }

  private fetch(): void {
    const id = this.id();
    if (!id) {
      this.load.set({ status: 'notFound' });
      return;
    }
    this.api.getRecipe(id).subscribe({
      next: (recipe) => this.load.set(recipe.deletedAt ? { status: 'notFound' } : { status: 'ok', recipe }),
      error: (err: { status?: number }) =>
        this.load.set({ status: err?.status === 404 || err?.status === 410 ? 'notFound' : 'error' }),
    });
  }

  /** Confirm (before -> after per ingredient), then PUT the scaled ingredients with the new servings. */
  protected confirmResize(): void {
    const r = this.recipe();
    if (!r || !this.resized()) return;
    const mode = this.mode();
    const after = this.scaledIngredients();
    const data: ConfirmDialogData = {
      title: `Save as ${this.servings()} servings?`,
      message: `Changes this recipe from ${r.servings} to ${this.servings()} servings.`,
      lines: r.ingredients.map((b, i) => `${formatQuantity(b, mode)} → ${formatQuantity(after[i], mode)}`),
      confirmLabel: 'Save new size',
    };
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, { data })
      .afterClosed()
      .subscribe((ok) => {
        if (ok === true) this.saveSize(r);
      });
  }

  private saveSize(r: Recipe): void {
    const servings = this.servings();
    const { id, version, createdAt: _c, updatedAt: _u, deletedAt: _d, ...rest } = r;
    void [_c, _u, _d];
    const input: RecipeInput = {
      ...rest,
      servings,
      // The scaled quantity no longer matches the original text, so drop it from scaled lines.
      ingredients: this.scaledIngredients().map((i, n) => {
        if (i === r.ingredients[n]) return i;
        const { original: _o, ...scaled } = i;
        void _o;
        return scaled;
      }),
    };
    this.savingSize.set(true);
    this.sizeError.set(null);
    this.api.updateRecipe(id, input, version).subscribe({
      next: (updated) => {
        this.savingSize.set(false);
        this.chosen.set(null);
        this.load.set({ status: 'ok', recipe: updated });
      },
      error: (err: unknown) => {
        this.savingSize.set(false);
        if (isVersionConflict(err)) this.conflict.set(true);
        else this.sizeError.set("Couldn't save the new size. Try again.");
      },
    });
  }

  protected imageSrc(key: string): string {
    return imageUrl(key);
  }

  protected step(delta: number): void {
    this.chosen.set(Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, this.servings() + delta)));
    this.added.set(new Set());
  }

  protected setMode(mode: Mode): void {
    this.mode.set(mode);
    this.added.set(new Set());
    try {
      localStorage.setItem(UNIT_MODE_KEY, mode);
    } catch {
      /* storage unavailable: keep the choice for this visit only */
    }
  }

  protected async toggleAwake(on: boolean): Promise<void> {
    this.awake.set(on);
    if (on) await this.acquire();
    else await this.release();
  }

  private async acquire(): Promise<void> {
    try {
      this.sentinel = (await (navigator as WakeLockNav).wakeLock?.request('screen')) ?? null;
    } catch {
      this.sentinel = null;
      this.awake.set(false);
    }
  }

  private async release(): Promise<void> {
    const s = this.sentinel;
    this.sentinel = null;
    try {
      await s?.release();
    } catch {
      /* already released */
    }
  }

  protected remove(): void {
    const id = this.recipe()?.id;
    if (!id) return;
    this.deleter.confirmAndDelete(id, { onDeleted: () => void this.router.navigate(['/recipes']) });
  }

  /** One-tap add of a single ingredient to the target list, with Undo. */
  protected addOne(ingredientId: string): void {
    const ing = this.scaledIngredients().find((i) => i.id === ingredientId);
    if (!ing || this.adding.has(ingredientId)) return;
    const name = listItemName(ing, this.mode());
    this.adding.add(ingredientId);
    this.listTarget
      .resolve()
      .pipe(
        switchMap((list) =>
          this.api.getList(list.id).pipe(
            switchMap((before) =>
              this.api.addItems(list.id, [{ name }]).pipe(
                map((res) => {
                  const known = new Set(before.items.map((it) => it.id));
                  return { list, created: res.items.find((it) => !known.has(it.id)) };
                }),
              ),
            ),
          ),
        ),
      )
      .subscribe({
        next: ({ list, created }) => {
          this.adding.delete(ingredientId);
          this.listTarget.remember(list.id);
          this.setAdded(ingredientId, true);
          if (!created) {
            this.snack.open(`Already on ${list.name}`, 'OK', { duration: 5000 });
            return;
          }
          this.snack
            .open(`Added to ${list.name}`, 'Undo', { duration: 5000 })
            .onAction()
            .subscribe(() => {
              this.api.deleteItem(list.id, created.id).subscribe({
                next: () => this.setAdded(ingredientId, false),
                error: () => this.snack.open("Couldn't undo that", 'OK', { duration: 5000 }),
              });
            });
        },
        error: () => {
          this.adding.delete(ingredientId);
          this.snack.open("Couldn't add that ingredient", 'OK', { duration: 5000 });
        },
      });
  }

  private setAdded(id: string, on: boolean): void {
    this.added.update((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Opens the add-to-list dialog with the ingredients as currently scaled and in the current unit mode. */
  protected addToList(): void {
    if (!this.recipe()) return;
    const data: AddToListData = { ingredients: this.scaledIngredients(), mode: this.mode() };
    this.dialog
      .open<AddToListDialog, AddToListData, AddToListResult>(AddToListDialog, { data })
      .afterClosed()
      .subscribe((res) => {
        if (!res) return;
        const noun = res.count === 1 ? 'item' : 'items';
        this.snack
          .open(`Added ${res.count} ${noun} to ${res.listName}`, 'View list', { duration: 8000 })
          .onAction()
          .subscribe(() => void this.router.navigate(['/lists']));
      });
  }
}

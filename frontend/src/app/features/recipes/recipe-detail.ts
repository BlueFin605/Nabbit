import { NgTemplateOutlet } from '@angular/common';
import { Component, DestroyRef, computed, inject, input, signal, type OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { map, switchMap } from 'rxjs';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import {
  convertTemperatures,
  anchorAmount,
  formatQuantity,
  isScaleAnchor,
  mapSteps,
  scaleIngredient,
  type Ingredient,
  type StepGroup,
  type StepNode,
  type Unit,
} from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { Recipe, RecipeInput } from '../../core/api/api.types';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/confirm-dialog';
import { HttpErrorResponse } from '@angular/common/http';
import { CONFLICT_MESSAGE, isVersionConflict } from './recipe-editor';
import { imageUrl } from '../../core/api/image-url';
import { RecipeDeleter } from './recipe-deleter';
import { AddToListDialog, listItemName, type AddToListData, type AddToListResult } from './add-to-list-dialog';
import { ListTarget } from '../lists/list-target';
import { RestoreSizeDialog, type RestoreSizeData } from './restore-size-dialog';
import { anchorFactor, formatFactor, roundHalf, unitsInFamily } from './scale-state';

export const UNIT_MODE_KEY = 'nabbit.unitMode';
export const MIN_SERVINGS = 1;
export const MAX_SERVINGS = 99;

type Mode = 'metric' | 'original';
type ScaleMode = 'servings' | { ingredientId: string };
const TOO_LARGE_MSG = 'This recipe is too large to keep a backup of the original size.';

/** The backup doubles the payload, so the API can answer 400 { error: 'too_large' }. */
function isTooLarge(err: unknown): boolean {
  return err instanceof HttpErrorResponse && err.status === 400 && (err.error as { error?: string } | null)?.error === 'too_large';
}

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
  imports: [NgTemplateOutlet, RouterLink, MatButtonModule, MatButtonToggleModule, MatSlideToggleModule],
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
            <div class="scale-by-field">
              <label for="scale-by">Scale by</label>
              <select id="scale-by" class="scale-by" [value]="scaleValue()" (change)="chooseScale($event)">
                <option value="servings" [selected]="scaleValue() === 'servings'">Servings</option>
                @for (a of anchors(); track a.id) {
                  <option [value]="a.id" [selected]="scaleValue() === a.id">{{ a.name }}</option>
                }
              </select>
            </div>

            @if (anchor(); as a) {
              <div class="anchor-box" role="group" [attr.aria-label]="'Amount of ' + a.name">
                <label for="anchor-amount">Amount of {{ a.name }}</label>
                <input
                  id="anchor-amount"
                  class="anchor-amount"
                  type="text"
                  inputmode="decimal"
                  [value]="amountValue()"
                  [attr.aria-invalid]="scaleError() ? 'true' : null"
                  [attr.aria-describedby]="scaleError() ? 'scale-error' : null"
                  (input)="setAmount($event)"
                />
                <label for="anchor-unit" class="visually-hidden">Unit</label>
                <!-- Changing the unit keeps the typed number: 6 l -> ml means 6 ml, not 6000 ml. -->
                <select id="anchor-unit" class="anchor-unit" [value]="unitValue()" (change)="setUnit($event)">
                  @for (u of anchorUnits(); track u) {
                    <option [value]="u" [selected]="u === unitValue()">{{ u || '(none)' }}</option>
                  }
                </select>
              </div>
              <p class="scale-summary" aria-live="polite">
                <span class="factor">×{{ factorText() }}</span>
                <span class="derived-servings">{{ servingsText() }}</span>
              </p>
            } @else {
              <div class="stepper" role="group" aria-label="Servings">
                <button mat-stroked-button type="button" aria-label="Fewer servings" [disabled]="servings() <= min" (click)="step(-1)">−</button>
                <output aria-live="polite">{{ servings() }}</output>
                <button mat-stroked-button type="button" aria-label="More servings" [disabled]="servings() >= max" (click)="step(1)">+</button>
                <span>servings</span>
              </div>
            }
            @if (scaleError(); as e) {
              <p id="scale-error" class="scale-error" role="alert">{{ e }}</p>
            }
            @if (resized()) {
              <button mat-stroked-button type="button" class="reset-scale" (click)="resetScale()">Reset</button>
            }

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
              <button mat-flat-button type="button" class="save-size" [disabled]="savingSize() || !servingsInBounds()"
                [attr.aria-describedby]="servingsInBounds() ? null : 'size-bounds'"
                (click)="confirmResize()"
              >
                Save as new size ({{ servingsLabel() }})
              </button>
              @if (!servingsInBounds()) {
                <p id="size-bounds" class="size-bounds">Resulting servings must be between {{ min }} and {{ max }}.</p>
              }
            </div>
          }
          @if (r.originalSize) {
            <div class="restore">
              <button mat-stroked-button type="button" class="restore-original" [disabled]="savingSize()" (click)="confirmRestore()">
                Restore original size
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
            <ng-container *ngTemplateOutlet="stepList; context: { $implicit: steps() }" />
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
    <ng-template #stepList let-nodes>
      @for (n of nodes; track $index) {
        @if (isString(n)) {
          <li>{{ n }}</li>
        } @else {
          @let g = asGroup(n);
          <li class="group">
            @if (g.heading) {
              <h3>{{ g.heading }}</h3>
            }
            <ol>
              <ng-container *ngTemplateOutlet="stepList; context: { $implicit: g.steps }" />
            </ol>
          </li>
        }
      }
    </ng-template>
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
  /** The ONE scale factor (1 = stored recipe); both the stepper and the ingredient amount box set it. */
  private readonly factor = signal(1);
  protected readonly scaleMode = signal<ScaleMode>('servings');
  /** Typed amount / unit for the anchor box; null = the stored anchor amount and unit. */
  private readonly amountText = signal<string | null>(null);
  private readonly amountUnit = signal<Unit | null>(null);
  protected readonly scaleError = signal<string | null>(null);

  protected readonly recipe = computed(() => {
    const l = this.load();
    return l.status === 'ok' ? l.recipe : null;
  });
  /** Derived from the factor, rounded to the nearest 0.5. */
  protected readonly servings = computed(() => roundHalf((this.recipe()?.servings ?? 1) * this.factor()));

  /** Whether the derived servings are a size the recipe can be saved at (the stepper's range). */
  protected readonly servingsInBounds = computed(() => this.servings() >= MIN_SERVINGS && this.servings() <= MAX_SERVINGS);
  /** The servings phrase for display: never "0"; out-of-range values read "under min serving" / "over max servings". */
  protected readonly servingsLabel = computed(() => {
    const n = this.servings();
    if (n < MIN_SERVINGS) return `under ${MIN_SERVINGS} serving`;
    if (n > MAX_SERVINGS) return `over ${MAX_SERVINGS} servings`;
    return `${n} ${n === 1 ? 'serving' : 'servings'}`;
  });
  protected readonly servingsText = computed(() => (this.servingsInBounds() ? `≈ ${this.servingsLabel()}` : this.servingsLabel()));

  protected readonly anchors = computed(() => (this.recipe()?.ingredients ?? []).filter(isScaleAnchor));
  /** The stored ingredient the amount box scales by, or null in Servings mode. */
  protected readonly anchor = computed((): Ingredient | null => {
    const m = this.scaleMode();
    return m === 'servings' ? null : (this.anchors().find((i) => i.id === m.ingredientId) ?? null);
  });
  protected readonly scaleValue = computed(() => this.anchor()?.id ?? 'servings');
  protected readonly amountValue = computed(() => {
    const a = this.anchor();
    return this.amountText() ?? (a ? String(Number(anchorAmount(a).quantity.toFixed(3))) : '');
  });
  protected readonly unitValue = computed((): Unit => {
    const a = this.anchor();
    return this.amountUnit() ?? (a ? anchorAmount(a).unit : '');
  });
  protected readonly anchorUnits = computed(() => unitsInFamily(this.anchor()?.unit ?? ''));
  protected readonly factorText = computed(() => formatFactor(this.factor()));

  /** The stored ingredients scaled to the chosen servings (a new array; the recipe is untouched). */
  readonly scaledIngredients = computed<Ingredient[]>(() => {
    const r = this.recipe();
    if (!r) return [];
    const f = this.factor();
    return r.ingredients.map((i) => scaleIngredient(i, f));
  });

  /** The size differs from the stored recipe (either mode). */
  protected readonly resized = computed(() => !!this.recipe() && this.factor() !== 1);

  protected readonly lines = computed(() =>
    this.scaledIngredients().map((i) => ({
      id: i.id,
      name: i.name,
      text: formatQuantity(i, this.mode()),
      note: i.note,
      fixed: !i.scalable,
    })),
  );
  protected readonly steps = computed((): StepNode[] => {
    const r = this.recipe();
    if (!r) return [];
    return this.mode() === 'metric' ? mapSteps(r.steps, convertTemperatures) : r.steps;
  });

  protected isString(n: StepNode): n is string {
    return typeof n === 'string';
  }

  /** Narrows a non-string node inside the recursive (untyped `let-nodes`) template context. */
  protected asGroup(n: StepNode): StepGroup {
    return n as StepGroup;
  }

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
    this.resetScale();
    this.fetch();
  }

  private fetch(): void {
    const id = this.id();
    if (!id) {
      this.load.set({ status: 'notFound' });
      return;
    }
    this.api.getRecipe(id).subscribe({
      next: (recipe) => {
        this.load.set(recipe.deletedAt ? { status: 'notFound' } : { status: 'ok', recipe });
        this.openScaleMode(recipe);
      },
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
      // The first resize keeps the pre-save size as a backup; later saves leave it as is.
      originalSize: r.originalSize ?? { servings: r.servings, ingredients: r.ingredients },
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
        this.resetScale();
        this.load.set({ status: 'ok', recipe: updated });
      },
      error: (err: unknown) => {
        this.savingSize.set(false);
        if (isVersionConflict(err)) this.conflict.set(true);
        else this.sizeError.set(isTooLarge(err) ? TOO_LARGE_MSG : "Couldn't save the new size. Try again.");
      },
    });
  }

  /** Compare dialog (current -> first size), then PUT the first size back with the backup removed. */
  protected confirmRestore(): void {
    const r = this.recipe();
    const original = r?.originalSize;
    if (!r || !original) return;
    const data: RestoreSizeData = {
      currentServings: r.servings,
      originalServings: original.servings,
      current: r.ingredients,
      original: original.ingredients,
      mode: this.mode(),
      clearsScaleBy: !!r.scaleBy && !original.ingredients.some((i) => i.id === r.scaleBy),
    };
    this.dialog
      .open<RestoreSizeDialog, RestoreSizeData, boolean>(RestoreSizeDialog, { data })
      .afterClosed()
      .subscribe((ok) => {
        if (ok === true) this.restore(r, original);
      });
  }

  private restore(r: Recipe, original: NonNullable<Recipe['originalSize']>): void {
    const { id, version, createdAt: _c, updatedAt: _u, deletedAt: _d, originalSize: _o, ...rest } = r;
    void [_c, _u, _d, _o];
    // scaleBy must name an ingredient in the same body; drop it if the original no longer has it.
    const { scaleBy, ...withoutScaleBy } = rest;
    const input: RecipeInput = {
      ...withoutScaleBy,
      ...(scaleBy && original.ingredients.some((i) => i.id === scaleBy) ? { scaleBy } : {}),
      servings: original.servings,
      ingredients: original.ingredients,
    };
    this.savingSize.set(true);
    this.sizeError.set(null);
    this.api.updateRecipe(id, input, version).subscribe({
      next: (updated) => {
        this.savingSize.set(false);
        this.resetScale();
        this.load.set({ status: 'ok', recipe: updated });
      },
      error: (err: unknown) => {
        this.savingSize.set(false);
        if (isVersionConflict(err)) this.conflict.set(true);
        else this.sizeError.set(isTooLarge(err) ? TOO_LARGE_MSG : "Couldn't restore the original size. Try again.");
      },
    });
  }

  protected imageSrc(key: string): string {
    return imageUrl(key);
  }

  protected step(delta: number): void {
    const r = this.recipe();
    if (!r) return;
    const next = Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, this.servings() + delta));
    this.factor.set(next / r.servings);
    this.added.set(new Set());
  }

  /** Opens in ingredient mode when the recipe's scaleBy names an anchor ingredient, else Servings. */
  private openScaleMode(r: Recipe): void {
    const by = r.scaleBy && r.ingredients.find((i) => i.id === r.scaleBy && isScaleAnchor(i));
    this.scaleMode.set(by ? { ingredientId: by.id } : 'servings');
    this.resetScale();
  }

  protected chooseScale(ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value;
    this.scaleMode.set(v === 'servings' ? 'servings' : { ingredientId: v });
    this.resetScale();
  }

  /** Back to the stored servings / stored anchor amount (factor 1). Non-destructive. */
  protected resetScale(): void {
    this.factor.set(1);
    this.amountText.set(null);
    this.amountUnit.set(null);
    this.scaleError.set(null);
    this.added.set(new Set());
  }

  protected setAmount(ev: Event): void {
    this.amountText.set((ev.target as HTMLInputElement).value);
    this.applyAnchor();
  }

  protected setUnit(ev: Event): void {
    this.amountUnit.set((ev.target as HTMLSelectElement).value as Unit);
    this.applyAnchor();
  }

  /** Recomputes the factor from the amount box; on bad input shows an error and keeps the previous factor. */
  private applyAnchor(): void {
    const a = this.anchor();
    if (!a) return;
    const res = anchorFactor(a, this.amountValue(), this.unitValue());
    if ('error' in res) {
      this.scaleError.set(res.error);
      return;
    }
    this.scaleError.set(null);
    this.factor.set(res.factor);
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
    const r = this.recipe();
    if (!r?.id) return;
    this.deleter.confirmAndDelete(r.id, { onDeleted: () => void this.router.navigate(['/recipes']) }, r.title);
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

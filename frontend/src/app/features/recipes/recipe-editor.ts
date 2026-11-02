import { CdkDrag, CdkDragHandle, CdkDropList, moveItemInArray, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { COMMA, ENTER } from '@angular/cdk/keycodes';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule, type MatChipInputEvent } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { formatQuantity, newId, toMetric, type Ingredient, type Unit } from '@nabbit/recipe-core';
import { map, switchMap } from 'rxjs';
import { ApiClient } from '../../core/api/api-client';
import type { ImageContentType, RecipeInput } from '../../core/api/api.types';
import { imageUrl } from '../../core/api/image-url';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES: readonly ImageContentType[] = ['image/jpeg', 'image/png', 'image/webp'];
export const CONFLICT_MESSAGE = 'This recipe changed on another device — reload';
export const UNITS: readonly { value: Unit; label: string }[] = [
  { value: '', label: '(none)' },
  { value: 'piece', label: 'piece' },
  { value: 'tsp', label: 'tsp' },
  { value: 'tbsp', label: 'tbsp' },
  { value: 'floz', label: 'fl oz' },
  { value: 'cup', label: 'cup' },
  { value: 'pint', label: 'pint' },
  { value: 'quart', label: 'quart' },
  { value: 'gallon', label: 'gallon' },
  { value: 'ml', label: 'ml' },
  { value: 'l', label: 'l' },
  { value: 'oz', label: 'oz' },
  { value: 'lb', label: 'lb' },
  { value: 'g', label: 'g' },
  { value: 'kg', label: 'kg' },
];

/** True for the API's 409 version_conflict. */
export function isVersionConflict(err: unknown): boolean {
  return err instanceof HttpErrorResponse && err.status === 409;
}

interface StepRow {
  id: string;
  text: string;
}

/**
 * Reusable recipe form used by the edit screen and the import preview. Holds its own working copy;
 * emits `saved` with a full RecipeInput. Editing an ingredient re-runs `toMetric` and drops `original`.
 */
@Component({
  selector: 'app-recipe-editor',
  imports: [
    CdkDrag,
    CdkDragHandle,
    CdkDropList,
    MatButtonModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
  ],
  styleUrl: './recipe-editor.scss',
  template: `
    @if (photoSrc(); as src) {
      <img class="photo" [src]="src" alt="Recipe photo" />
    }
    @if (previewImage() && !imageKey()) {
      <p class="photo-note" role="note">Photo not saved — add one in the editor.</p>
      @if (!showPreview()) {
        <button mat-button type="button" class="show-original" (click)="showPreview.set(true)">Show original photo</button>
      }
    }
    <div class="photo-actions">
      <label class="photo-pick">
        <input type="file" class="photo-input" accept="image/jpeg,image/png,image/webp" (change)="onPhoto($event)" />
        <span>{{ photoSrc() ? 'Change photo' : 'Add photo' }}</span>
      </label>
      @if (imageKey()) {
        <button mat-button type="button" class="remove-photo" (click)="imageKey.set(undefined)">Remove photo</button>
      }
      @if (uploading()) {
        <span class="uploading" role="status"><mat-spinner diameter="20" /> Uploading…</span>
      }
    </div>
    @if (photoError(); as pe) {
      <p class="error photo-error" role="alert">{{ pe }}</p>
    }

    <mat-form-field appearance="outline" class="box">
      <mat-label>Title</mat-label>
      <input matInput class="title" [value]="title()" (input)="title.set(val($event))" />
    </mat-form-field>
    <mat-form-field appearance="outline" class="box">
      <mat-label>Servings</mat-label>
      <input matInput class="servings" type="number" min="1" inputmode="numeric" [value]="servings()" (input)="setServings($event)" />
    </mat-form-field>

    <mat-form-field appearance="outline" class="box">
      <mat-label>Tags</mat-label>
      <mat-chip-grid #grid aria-label="Tags">
        @for (t of tags(); track t) {
          <mat-chip-row class="tag" (removed)="removeTag(t)">
            {{ t }}
            <button matChipRemove type="button" [attr.aria-label]="'Remove tag ' + t">×</button>
          </mat-chip-row>
        }
        <input
          class="tag-input"
          placeholder="Add a tag"
          [matChipInputFor]="grid"
          [matChipInputSeparatorKeyCodes]="separators"
          [matChipInputAddOnBlur]="true"
          (matChipInputTokenEnd)="addTag($event)"
        />
      </mat-chip-grid>
    </mat-form-field>

    <h2>Ingredients</h2>
    <div class="list ingredients" cdkDropList (cdkDropListDropped)="dropIngredient($event)">
      @for (ing of ingredients(); track ing.id; let i = $index) {
        <div class="ingredient" cdkDrag>
          <div class="row-head">
            <button type="button" class="handle" cdkDragHandle aria-label="Reorder ingredient">⠿</button>
            <button mat-button type="button" class="remove-ingredient" [attr.aria-label]="'Remove ' + (ing.name || 'ingredient')" (click)="removeIngredient(i)">Remove</button>
          </div>
          <div class="fields">
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="f-qty">
              <mat-label>Qty</mat-label>
              <input matInput class="qty" type="number" step="any" min="0" inputmode="decimal" [value]="ing.quantity ?? ''" (input)="setQuantity(i, $event)" />
            </mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="f-unit">
              <mat-label>Unit</mat-label>
              <select matNativeControl class="unit" (change)="setUnit(i, $event)">
                @for (u of units; track u.value) {
                  <option [value]="u.value" [selected]="u.value === ing.unit">{{ u.label }}</option>
                }
              </select>
            </mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="f-name">
              <mat-label>Name</mat-label>
              <input matInput class="name" [value]="ing.name" (input)="setName(i, $event)" />
            </mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic" class="f-note">
              <mat-label>Note</mat-label>
              <input matInput class="note" [value]="ing.note ?? ''" (input)="setNote(i, $event)" />
            </mat-form-field>
          </div>
          <label class="scales"><input type="checkbox" class="scalable" [checked]="ing.scalable" (change)="setScalable(i, $event)" /> Scales with servings</label>
          @if (ing.metric || ing.original) {
            <details class="preview">
              <summary>{{ metric(ing) }}</summary>
              @if (ing.original) {
                <p class="original">Original: {{ ing.original }}</p>
              }
            </details>
          }
        </div>
      }
    </div>
    <button mat-button type="button" class="add-ingredient" (click)="addIngredient()">Add ingredient</button>

    <h2>Steps</h2>
    <div class="list steps" cdkDropList (cdkDropListDropped)="dropStep($event)">
      @for (s of steps(); track s.id; let i = $index) {
        <div class="step-row" cdkDrag>
          <button type="button" class="handle" cdkDragHandle aria-label="Reorder step">⠿</button>
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="step-field">
            <mat-label>Step {{ i + 1 }}</mat-label>
            <textarea matInput class="step" rows="2" [value]="s.text" (input)="setStep(i, $event)"></textarea>
          </mat-form-field>
          <button mat-button type="button" class="remove-step" [attr.aria-label]="'Remove step ' + (i + 1)" (click)="removeStep(i)">Remove</button>
        </div>
      }
    </div>
    <button mat-button type="button" class="add-step" (click)="addStep()">Add step</button>

    @if (conflict()) {
      <div class="conflict" role="alert">
        <span>{{ conflictMessage }}</span>
        <button mat-flat-button type="button" class="reload" (click)="reload.emit()">Reload</button>
      </div>
    }
    @if (error(); as e) {
      <p class="error" role="alert">{{ e }}</p>
    }
    <div class="actions">
      <button mat-flat-button type="button" class="save" [disabled]="saving() || uploading()" (click)="save()">{{ saveLabel() }}</button>
      <button mat-button type="button" class="discard" [disabled]="saving()" (click)="cancelled.emit()">{{ cancelLabel() }}</button>
      <ng-content />
    </div>
  `,
})
export class RecipeEditor {
  private readonly api = inject(ApiClient);

  /** The recipe to edit; changing this input resets the form (e.g. after Reload). */
  readonly recipe = input.required<RecipeInput>();
  /** Preview photo when the recipe has no stored image yet (e.g. an imported page's image). */
  readonly previewImage = input<string>();
  readonly saving = input(false);
  readonly error = input<string | null>(null);
  readonly conflict = input(false);
  readonly saveLabel = input('Save');
  readonly cancelLabel = input('Discard');

  readonly saved = output<RecipeInput>();
  readonly cancelled = output<void>();
  readonly reload = output<void>();

  protected readonly separators = [ENTER, COMMA];
  protected readonly units = UNITS;
  protected readonly conflictMessage = CONFLICT_MESSAGE;

  protected readonly title = signal('');
  protected readonly servings = signal(1);
  protected readonly tags = signal<string[]>([]);
  protected readonly imageKey = signal<string | undefined>(undefined);
  readonly ingredients = signal<Ingredient[]>([]);
  readonly steps = signal<StepRow[]>([]);
  protected readonly uploading = signal(false);
  protected readonly photoError = signal<string | null>(null);

  private readonly baseline = signal('');
  private readonly snapshot = computed(() =>
    JSON.stringify({
      title: this.title(),
      servings: this.servings(),
      tags: this.tags(),
      imageKey: this.imageKey() ?? null,
      ingredients: this.ingredients(),
      steps: this.steps().map((s) => s.text),
    }),
  );
  /** True when the form differs from what was loaded. */
  readonly dirty = computed(() => this.snapshot() !== this.baseline());

  /** A third-party preview image is only loaded after an explicit tap (no automatic hot-link / IP leak). */
  protected readonly showPreview = signal(false);

  protected readonly photoSrc = computed(() => {
    const key = this.imageKey();
    return key ? imageUrl(key) : this.showPreview() ? this.previewImage() : undefined;
  });

  constructor() {
    effect(() => {
      const r = this.recipe();
      untracked(() => this.reset(r));
    });
  }

  private reset(r: RecipeInput): void {
    this.title.set(r.title);
    this.servings.set(r.servings);
    this.tags.set([...r.tags]);
    this.imageKey.set(r.imageKey);
    this.ingredients.set(r.ingredients.map((i) => ({ ...i })));
    this.steps.set(r.steps.map((text) => ({ id: newId(), text })));
    this.photoError.set(null);
    this.baseline.set(this.snapshot());
  }

  protected val(e: Event): string {
    return (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  protected metric(i: Ingredient): string {
    return formatQuantity(i, 'metric');
  }

  protected setServings(e: Event): void {
    const n = Number(this.val(e));
    if (Number.isFinite(n) && n >= 1) this.servings.set(Math.round(n));
  }

  // ---- tags ----

  protected addTag(e: MatChipInputEvent): void {
    const t = e.value.trim();
    if (t && !this.tags().includes(t)) this.tags.update((all) => [...all, t]);
    e.chipInput.clear();
  }

  protected removeTag(tag: string): void {
    this.tags.update((all) => all.filter((t) => t !== tag));
  }

  // ---- ingredients ----

  /** Applies an edit: drops `original` (it no longer describes the line) and recomputes the metric text. */
  protected edit(index: number, patch: Partial<Ingredient>, drop: (keyof Ingredient)[] = []): void {
    this.ingredients.update((all) =>
      all.map((ing, i) => {
        if (i !== index) return ing;
        const next: Ingredient = { ...ing, ...patch };
        delete next.original;
        for (const k of drop) delete (next as Partial<Ingredient>)[k];
        return toMetric(next);
      }),
    );
  }

  protected setQuantity(index: number, e: Event): void {
    const raw = this.val(e).trim();
    if (raw === '') return this.edit(index, { quantity: null, scalable: false }, ['quantityMax']);
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) this.edit(index, { quantity: n }, ['quantityMax']);
  }

  protected setUnit(index: number, e: Event): void {
    this.edit(index, { unit: this.val(e) as Unit });
  }

  protected setName(index: number, e: Event): void {
    this.edit(index, { name: this.val(e) });
  }

  protected setNote(index: number, e: Event): void {
    const note = this.val(e);
    this.edit(index, note ? { note } : {}, note ? [] : ['note']);
  }

  protected setScalable(index: number, e: Event): void {
    this.edit(index, { scalable: (e.target as HTMLInputElement).checked });
  }

  protected addIngredient(): void {
    this.ingredients.update((all) => [...all, { id: newId(), quantity: null, unit: '', name: '', scalable: false }]);
  }

  protected removeIngredient(index: number): void {
    this.ingredients.update((all) => all.filter((_, i) => i !== index));
  }

  dropIngredient(e: CdkDragDrop<unknown>): void {
    this.ingredients.update((all) => {
      const next = [...all];
      moveItemInArray(next, e.previousIndex, e.currentIndex);
      return next;
    });
  }

  // ---- steps ----

  protected setStep(index: number, e: Event): void {
    const text = this.val(e);
    this.steps.update((all) => all.map((s, i) => (i === index ? { ...s, text } : s)));
  }

  protected addStep(): void {
    this.steps.update((all) => [...all, { id: newId(), text: '' }]);
  }

  protected removeStep(index: number): void {
    this.steps.update((all) => all.filter((_, i) => i !== index));
  }

  dropStep(e: CdkDragDrop<unknown>): void {
    this.steps.update((all) => {
      const next = [...all];
      moveItemInArray(next, e.previousIndex, e.currentIndex);
      return next;
    });
  }

  // ---- photo: pick -> presign -> direct upload to S3 -> imageKey ----

  protected onPhoto(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type as ImageContentType)) {
      this.photoError.set('Choose a JPEG, PNG or WebP image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      this.photoError.set('That image is over 5 MB.');
      return;
    }
    this.photoError.set(null);
    this.uploading.set(true);
    this.api
      .presignImageUpload(file.type as ImageContentType)
      .pipe(switchMap((up) => this.api.uploadImage(up, file).pipe(map(() => up.imageKey))))
      .subscribe({
        next: (key) => {
          this.imageKey.set(key);
          this.uploading.set(false);
        },
        error: () => {
          this.uploading.set(false);
          this.photoError.set('Could not upload that photo. Try again.');
        },
      });
  }

  // ---- save ----

  /** Builds the RecipeInput from the form (blank ingredients/steps dropped). */
  value(): RecipeInput {
    const { deletedAt: _deleted, ...rest } = this.recipe() as RecipeInput & { deletedAt?: string };
    void _deleted;
    const out: RecipeInput = {
      ...rest,
      title: this.title().trim() || 'Untitled recipe',
      servings: this.servings(),
      tags: this.tags(),
      ingredients: this.ingredients().filter((i) => i.name.trim()),
      steps: this.steps().map((s) => s.text).filter((s) => s.trim()),
    };
    const key = this.imageKey();
    if (key) out.imageKey = key;
    else delete out.imageKey;
    return out;
  }

  protected save(): void {
    if (this.saving() || this.uploading()) return;
    this.saved.emit(this.value());
  }
}

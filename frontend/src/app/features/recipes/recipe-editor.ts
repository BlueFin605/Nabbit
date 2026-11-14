import { CdkDrag, CdkDragHandle, CdkDropList, moveItemInArray, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { COMMA, ENTER } from '@angular/cdk/keycodes';
import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule, type MatChipInputEvent } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MAX_STEP_DEPTH, formatQuantity, isScaleAnchor, newId, toMetric, type Ingredient, type Unit } from '@nabbit/recipe-core';
import { map, switchMap } from 'rxjs';
import { ApiClient } from '../../core/api/api-client';
import type { ImageContentType, RecipeInput } from '../../core/api/api.types';
import { imageUrl } from '../../core/api/image-url';
import { ConfirmDialog, type ConfirmDialogData } from '../../shared/confirm-dialog';
import { addGroup, addStep, canAddGroup, canAddStep, canIndent, canOutdent, fromRows, hasChildren, indent, lastChildId, moveWithin, neighbourAfterRemove, outdent, removeRow, setHeading, setText, shape, stepNumber, toRows, type StepRow } from './step-rows';

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
    NgTemplateOutlet,
    MatProgressSpinnerModule,
  ],
  styleUrl: './recipe-editor.scss',
  template: `
    @if (photoSrc(); as src) {
      <img class="photo" [src]="src" alt="Recipe photo" />
    }
    @if (!imageKey() && (previewImage() || options().length)) {
      @if (previewImage()) {
        <p class="photo-note" role="note">Photo found, will be saved</p>
        <button mat-button type="button" class="decline-photo" (click)="declinePhoto()">Don't use this photo</button>
      }
      @if (!showPreview()) {
        <button mat-button type="button" class="show-options" (click)="showPreview.set(true)">{{ previewImage() ? 'Show photo options' : 'Use a found photo' }}</button>
      } @else {
        <div class="candidates">
          @for (c of options(); track c) {
            <button type="button" class="candidate" [class.chosen]="c === previewImage()" [attr.aria-pressed]="c === previewImage()" aria-label="Use this photo" (click)="candidateChosen.emit(c)">
              <img [src]="c" alt="" width="72" height="72" />
            </button>
          }
        </div>
      }
    }
    <div class="photo-actions">
      <label class="photo-pick">
        <input type="file" class="photo-input" accept="image/jpeg,image/png,image/webp" (change)="onPhoto($event)" />
        <span>{{ photoSrc() ? 'Change photo' : 'Add photo' }}</span>
      </label>
      @if (imageKey()) {
        <button mat-button type="button" class="remove-photo" (click)="removePhoto()">Remove photo</button>
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
    @if (hasAnchor()) {
      <label class="scale-by-label scale-by-none-label"><input type="radio" name="scaleBy" class="scale-by-none" aria-label="No default scale-by ingredient" [checked]="effectiveScaleBy() === null" (change)="scaleBy.set(null)" /> No default scale-by ingredient</label>
    }
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
          @if (isAnchor(ing)) {
            <label class="scale-by-label"><input type="radio" name="scaleBy" class="scale-by" [attr.aria-label]="'Default scale-by: ' + (ing.name || 'ingredient')" [checked]="effectiveScaleBy() === ing.id" (change)="scaleBy.set(ing.id)" /> Default scale-by</label>
          }
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
    <div class="steps">
      <ng-container *ngTemplateOutlet="level; context: { $implicit: steps(), parent: null, trail: '' }" />
    </div>

    <ng-template #level let-rows let-parent="parent" let-trail="trail">
      <div class="level list" cdkDropList (cdkDropListDropped)="dropRow($event, parent)">
        @for (r of rows; track r.id; let i = $index) {
          @if (r.kind === 'step') {
            <div class="step-row" cdkDrag [attr.data-row]="r.id">
              <button type="button" class="handle" cdkDragHandle [attr.aria-label]="'Reorder ' + rowLabel(rows, i) + trail">⠿</button>
              <mat-form-field appearance="outline" subscriptSizing="dynamic" class="step-field">
                <mat-label>Step {{ stepNo(rows, i) }}</mat-label>
                <textarea matInput class="step" rows="2" [value]="r.text" (input)="setStep(r.id, $event)"></textarea>
              </mat-form-field>
              <div class="row-controls">
                <button mat-button type="button" class="indent" [disabled]="!canIndentRow(r.id)" [attr.aria-label]="'Indent ' + rowLabel(rows, i) + trail" (click)="indentRow(r.id)">Indent</button>
                <button mat-button type="button" class="outdent" [disabled]="!canOutdentRow(r.id)" [attr.aria-label]="'Outdent ' + rowLabel(rows, i) + trail" (click)="outdentRow(r.id)">Outdent</button>
                <button mat-button type="button" class="remove-step" [attr.aria-label]="'Remove ' + rowLabel(rows, i) + trail" (click)="removeStepRow(r.id)">Remove</button>
              </div>
            </div>
          } @else {
            <div class="group-row" cdkDrag [attr.data-row]="r.id">
              <div class="group-head">
                <button type="button" class="handle" cdkDragHandle [attr.aria-label]="'Reorder ' + rowLabel(rows, i) + trail">⠿</button>
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="step-field">
                  <mat-label>Group heading</mat-label>
                  <input matInput class="group-heading" [value]="r.heading" (input)="setGroupHeading(r.id, $event)" />
                </mat-form-field>
              </div>
              <div class="row-controls">
                <button mat-button type="button" class="indent" [disabled]="!canIndentRow(r.id)" [attr.aria-label]="'Indent ' + rowLabel(rows, i) + trail" (click)="indentRow(r.id)">Indent</button>
                <button mat-button type="button" class="outdent" [disabled]="!canOutdentRow(r.id)" [attr.aria-label]="'Outdent ' + rowLabel(rows, i) + trail" (click)="outdentRow(r.id)">Outdent</button>
                <button mat-button type="button" class="remove-group" [attr.aria-label]="'Remove ' + rowLabel(rows, i) + trail" (click)="removeGroupRow(r)">Remove group</button>
              </div>
              <div class="group-body">
                <ng-container *ngTemplateOutlet="level; context: { $implicit: r.children, parent: r.id, trail: ' in ' + rowLabel(rows, i) + trail }" />
              </div>
            </div>
          }
        }
      </div>
      <div class="level-actions" [attr.data-add]="parent ?? 'root'">
        <button mat-button type="button" class="add-step" [disabled]="!canAddStepAt(parent)" [attr.title]="canAddStepAt(parent) ? null : depthLimitMessage" [attr.aria-description]="canAddStepAt(parent) ? null : depthLimitMessage" (click)="addStepRow(parent)">Add step</button>
        <button mat-button type="button" class="add-group" [disabled]="!canAddGroupAt(parent)" [attr.title]="canAddGroupAt(parent) ? null : depthLimitMessage" [attr.aria-description]="canAddGroupAt(parent) ? null : depthLimitMessage" (click)="addGroupRow(parent)">Add group</button>
      </div>
    </ng-template>

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
      @if (!hideActions()) {
        <button mat-flat-button type="button" class="save" [disabled]="saving() || uploading()" (click)="save()">{{ saveLabel() }}</button>
        <button mat-button type="button" class="discard" [disabled]="saving()" (click)="cancelled.emit()">{{ cancelLabel() }}</button>
      }
      <ng-content />
    </div>
  `,
})
export class RecipeEditor {
  private readonly api = inject(ApiClient);
  private readonly dialog = inject(MatDialog);

  /** The recipe to edit; changing this input resets the form (e.g. after Reload). */
  readonly recipe = input.required<RecipeInput>();
  /** Preview photo when the recipe has no stored image yet (e.g. an imported page's image). */
  readonly previewImage = input<string>();
  /** Other photo candidates the user can pick between (shown as thumbnails after a tap). */
  readonly candidates = input<string[]>([]);
  readonly saving = input(false);
  readonly error = input<string | null>(null);
  readonly conflict = input(false);
  readonly saveLabel = input('Save');
  readonly cancelLabel = input('Discard');
  /** Hides the built-in Save/Discard buttons when the host supplies its own (call `requestSave()` instead). */
  readonly hideActions = input(false);

  readonly saved = output<RecipeInput>();
  /** A candidate was picked, or undefined when the user supplied/removed their own photo. */
  readonly candidateChosen = output<string | undefined>();
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
  /** Id of the default scale-by ingredient; only ever an id of a current anchor row. */
  protected readonly scaleBy = signal<string | null>(null);
  protected readonly isAnchor = isScaleAnchor;
  protected readonly hasAnchor = computed(() => this.ingredients().some(isScaleAnchor));
  /** scaleBy only counts while it names a current anchor row. */
  protected readonly effectiveScaleBy = computed(() => {
    const id = this.scaleBy();
    return id !== null && this.ingredients().some((i) => i.id === id && isScaleAnchor(i)) ? id : null;
  });
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
      scaleBy: this.effectiveScaleBy(),
      steps: shape(this.steps()),
    }),
  );
  /** True when the form differs from what was loaded. */
  readonly dirty = computed(() => this.snapshot() !== this.baseline());

  /** A third-party preview image is only loaded after an explicit tap (no automatic hot-link / IP leak). */
  protected readonly showPreview = signal(false);

  protected readonly options = computed(() => {
    const all = this.candidates();
    const chosen = this.previewImage();
    return all.length ? all : chosen ? [chosen] : [];
  });

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
    this.scaleBy.set(r.scaleBy ?? null);
    this.steps.set(toRows(r.steps));
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
    this.pruneScaleBy();
  }

  /** Actively clears scaleBy once its row is gone or no longer an anchor (so it cannot revive later). */
  private pruneScaleBy(): void {
    if (this.scaleBy() !== null && this.effectiveScaleBy() === null) this.scaleBy.set(null);
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
    this.pruneScaleBy();
  }

  dropIngredient(e: CdkDragDrop<unknown>): void {
    this.ingredients.update((all) => {
      const next = [...all];
      moveItemInArray(next, e.previousIndex, e.currentIndex);
      return next;
    });
  }

  // ---- steps ----

  protected setStep(id: string, e: Event): void {
    this.steps.update((rows) => setText(rows, id, this.val(e)));
  }

  protected setGroupHeading(id: string, e: Event): void {
    this.steps.update((rows) => setHeading(rows, id, this.val(e)));
  }

  protected stepNo(level: StepRow[], index: number): number {
    return stepNumber(level, index);
  }

  /** Per-row name used in button aria-labels: "step 2" or `group "Dough"`. */
  protected rowLabel(level: StepRow[], index: number): string {
    const r = level[index];
    if (r.kind === 'step') return `step ${stepNumber(level, index)}`;
    const heading = r.heading.trim();
    return heading ? `group "${heading}"` : `group ${level.slice(0, index + 1).filter((x) => x.kind === 'group').length}`;
  }

  protected readonly depthLimitMessage = `Steps and groups can be nested at most ${MAX_STEP_DEPTH} levels deep`;

  protected canAddStepAt(parentId: string | null): boolean {
    return canAddStep(this.steps(), parentId);
  }

  protected canAddGroupAt(parentId: string | null): boolean {
    return canAddGroup(this.steps(), parentId);
  }

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Row DOM is recreated when a row is re-parented, so focus is set after the next render: first usable selector wins. */
  private focusAfterRender(...selectors: string[]): void {
    afterNextRender(
      () => {
        for (const sel of selectors) {
          const el = this.host.nativeElement.querySelector<HTMLElement>(sel);
          if (el && !(el as HTMLButtonElement).disabled) {
            el.focus();
            return;
          }
        }
      },
      { injector: this.injector },
    );
  }

  private inputSel = (id: string) => `[data-row="${id}"] textarea.step, [data-row="${id}"] > .group-head input.group-heading`;
  private ctlSel = (id: string, cls: string) => `[data-row="${id}"] > .row-controls .${cls}`;

  protected addStepRow(parentId: string | null): void {
    const next = addStep(this.steps(), parentId);
    if (next === this.steps()) return;
    this.steps.set(next);
    const id = lastChildId(next, parentId);
    if (id) this.focusAfterRender(this.inputSel(id));
  }

  protected addGroupRow(parentId: string | null): void {
    const next = addGroup(this.steps(), parentId);
    if (next === this.steps()) return;
    this.steps.set(next);
    const id = lastChildId(next, parentId);
    if (id) this.focusAfterRender(this.inputSel(id));
  }

  protected canIndentRow(id: string): boolean {
    return canIndent(this.steps(), id);
  }

  protected canOutdentRow(id: string): boolean {
    return canOutdent(this.steps(), id);
  }

  protected indentRow(id: string): void {
    this.steps.update((rows) => indent(rows, id));
    this.focusAfterRender(this.ctlSel(id, 'indent'), this.inputSel(id));
  }

  protected outdentRow(id: string): void {
    this.steps.update((rows) => outdent(rows, id));
    this.focusAfterRender(this.ctlSel(id, 'outdent'), this.inputSel(id));
  }

  protected removeStepRow(id: string): void {
    const { neighbourId, parentId } = neighbourAfterRemove(this.steps(), id);
    this.steps.update((rows) => removeRow(rows, id));
    const add = `[data-add="${parentId ?? 'root'}"] .add-step`;
    if (neighbourId) this.focusAfterRender(this.ctlSel(neighbourId, 'remove-step'), this.ctlSel(neighbourId, 'remove-group'), add);
    else this.focusAfterRender(add);
  }

  /** Removing a group takes its children with it, so a non-empty one asks first. */
  protected removeGroupRow(group: StepRow): void {
    if (!hasChildren(group)) {
      this.removeStepRow(group.id);
      return;
    }
    const data: ConfirmDialogData = {
      title: 'Remove this group?',
      message: 'The group and every step inside it will be removed.',
      confirmLabel: 'Remove',
    };
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, { data })
      .afterClosed()
      .subscribe((ok) => {
        if (ok === true) this.removeStepRow(group.id);
      });
  }

  /** Reorders within one level; `parentId` is the group whose children moved (null = top level). */
  dropRow(e: CdkDragDrop<unknown>, parentId: string | null): void {
    this.steps.update((rows) => moveWithin(rows, parentId, e.previousIndex, e.currentIndex));
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
          this.candidateChosen.emit(undefined);
          this.uploading.set(false);
        },
        error: () => {
          this.uploading.set(false);
          this.photoError.set('Could not upload that photo. Try again.');
        },
      });
  }

  protected declinePhoto(): void {
    this.showPreview.set(false);
    this.candidateChosen.emit(undefined);
  }

  protected removePhoto(): void {
    this.imageKey.set(undefined);
    this.candidateChosen.emit(undefined);
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
      steps: fromRows(this.steps()),
    };
    const by = this.scaleBy();
    if (by !== null && out.ingredients.some((i) => i.id === by && isScaleAnchor(i))) out.scaleBy = by;
    else delete out.scaleBy;
    const key = this.imageKey();
    if (key) out.imageKey = key;
    else delete out.imageKey;
    return out;
  }

  /** Runs the same save path as the Save button (emits `saved` unless already saving or uploading). */
  requestSave(): void {
    this.save();
  }

  protected save(): void {
    if (this.saving() || this.uploading()) return;
    this.saved.emit(this.value());
  }
}

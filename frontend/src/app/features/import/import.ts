import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, signal, viewChild, type ElementRef, type OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { formatQuantity, parseIngredient, type Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { ImportErrorCode, ImportRequest, ImportResult, RecipeDraft, RecipeInput } from '../../core/api/api.types';

const FALLBACK = 'Paste the recipe text instead.';

/** Friendly copy per importer 422 code. */
export const IMPORT_ERROR_MESSAGES: Record<ImportErrorCode, string> = {
  bad_url: "That doesn't look like a valid link.",
  blocked_address: "We can't open that address.",
  too_large: 'That page is too big to import.',
  timeout: 'That site took too long to respond.',
  bad_status: "That site wouldn't let us read the page.",
  not_html: "That link isn't a web page.",
  too_many_redirects: 'That link redirects too many times.',
};
export const RATE_LIMIT_MESSAGE = "You've imported a lot — try again in a while.";
export const GENERIC_ERROR_MESSAGE = "Couldn't import that recipe.";

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** First http(s) URL found in free text, minus trailing punctuation. */
export function firstUrl(text: string | undefined): string | undefined {
  const m = text ? URL_RE.exec(text) : null;
  return m ? m[0].replace(/[.,;:!?)\]]+$/, '') : undefined;
}

/** `https://` values go as `{url}`, anything else as `{text}`. */
export function toImportRequest(value: string): ImportRequest {
  const v = value.trim();
  return v.toLowerCase().startsWith('https://') ? { url: v } : { text: v };
}

/**
 * Recipe import and Web Share Target landing page (GET /import?title=&text=&url=).
 * Paste a link or text, preview the parsed draft, then save (POST /recipes) or discard.
 */
@Component({
  selector: 'app-import',
  imports: [MatButtonModule, MatFormFieldModule, MatInputModule, MatProgressSpinnerModule],
  styles: `
    :host { display: block; }
    .box { width: 100%; }
    .banner { padding: 12px 16px; border-radius: 12px; margin: 12px 0; background: var(--mat-sys-tertiary-container, #fde7b0); }
    .error { color: var(--mat-sys-error, #b3261e); margin: 8px 0; }
    .loading { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
    .photo { width: 100%; max-height: 260px; object-fit: cover; border-radius: 16px; }
    .row { display: flex; gap: 8px; align-items: flex-start; }
    .row mat-form-field { flex: 1; }
    .actions { display: flex; gap: 12px; margin: 16px 0 88px; }
    ul.ingredients { list-style: none; padding: 0; margin: 0 0 8px; }
    ul.ingredients li { display: flex; align-items: center; gap: 8px; min-height: 48px; }
    ul.ingredients .qty { flex: 1; }
    details summary { cursor: pointer; min-height: 48px; display: flex; align-items: center; }
    .original { color: var(--mat-sys-on-surface-variant, #555); font-size: 0.9em; margin: 0 0 8px; }
  `,
  template: `
    <h1>Import a recipe</h1>

    @if (!draft()) {
      <mat-form-field class="box" appearance="outline">
        <mat-label>Paste a link or recipe text</mat-label>
        <textarea #box matInput rows="4" [value]="value()" (input)="onInput($event)"></textarea>
      </mat-form-field>

      @if (error(); as e) {
        <p class="error" role="alert">{{ e }}</p>
      }

      @if (loading()) {
        <div class="loading" role="status" aria-live="polite">
          <mat-spinner diameter="28" />
          <span>Importing…</span>
        </div>
      }

      <button mat-flat-button type="button" class="import-btn" [disabled]="loading() || !value().trim()" (click)="doImport()">
        Import
      </button>
    } @else {
      @if (draft(); as d) {
        @if (d.confidence === 'heuristic') {
          <p class="banner" role="note">Check this one carefully — we guessed at the layout of this page.</p>
        }
        @if (isEmpty()) {
          <p class="banner" role="note">We couldn't find a recipe there. Fill it in yourself — the source link is kept.</p>
        }
        @if (imageUrl(); as img) {
          <img class="photo" [src]="img" alt="Photo found on the page" />
        }

        <mat-form-field appearance="outline" class="box">
          <mat-label>Title</mat-label>
          <input matInput class="title" [value]="d.recipe.title" (input)="setTitle($event)" />
        </mat-form-field>
        <mat-form-field appearance="outline" class="box">
          <mat-label>Servings</mat-label>
          <input matInput class="servings" type="number" min="1" [value]="d.recipe.servings" (input)="setServings($event)" />
        </mat-form-field>

        <h2>Ingredients</h2>
        <ul class="ingredients">
          @for (ing of d.recipe.ingredients; track ing.id; let i = $index) {
            <li>
              <details class="qty">
                <summary>{{ metric(ing) }}</summary>
                <p class="original">Original: {{ original(ing) }}</p>
              </details>
              <button mat-button type="button" class="remove-ingredient" [attr.aria-label]="'Remove ' + ing.name" (click)="removeIngredient(i)">Remove</button>
            </li>
          }
        </ul>
        <div class="row">
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Add ingredient</mat-label>
            <input matInput class="new-ingredient" [value]="newIngredient()" (input)="newIngredient.set(val($event))" (keydown.enter)="addIngredient()" />
          </mat-form-field>
          <button mat-button type="button" class="add-ingredient" (click)="addIngredient()">Add</button>
        </div>

        <h2>Steps</h2>
        @for (s of d.recipe.steps; track $index; let i = $index) {
          <div class="row">
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Step {{ i + 1 }}</mat-label>
              <textarea matInput class="step" rows="2" [value]="s" (input)="setStep(i, $event)"></textarea>
            </mat-form-field>
            <button mat-button type="button" class="remove-step" [attr.aria-label]="'Remove step ' + (i + 1)" (click)="removeStep(i)">Remove</button>
          </div>
        }
        <button mat-button type="button" class="add-step" (click)="addStep()">Add step</button>

        @if (error(); as e) {
          <p class="error" role="alert">{{ e }}</p>
        }
        <div class="actions">
          <button mat-flat-button type="button" class="save" [disabled]="saving()" (click)="save()">Save</button>
          <button mat-button type="button" class="discard" [disabled]="saving()" (click)="discard()">Discard</button>
        </div>
      }
    }
  `,
})
export class Import implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);

  /** Web Share Target query params, bound via withComponentInputBinding. */
  readonly title = input<string>();
  readonly text = input<string>();
  readonly url = input<string>();

  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>('box');

  protected readonly value = signal('');
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly draft = signal<RecipeDraft | null>(null);
  protected readonly imageUrl = signal<string | undefined>(undefined);
  protected readonly newIngredient = signal('');
  protected readonly isEmpty = computed(() => {
    const d = this.draft();
    return !!d && d.recipe.ingredients.length === 0 && d.recipe.steps.length === 0;
  });

  private sourceUrl: string | undefined;

  ngOnInit(): void {
    const shared = this.url()?.trim() || firstUrl(this.text()) || this.text()?.trim() || '';
    if (shared) {
      this.value.set(shared);
      this.doImport();
    }
  }

  protected val(e: Event): string {
    return (e.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected onInput(e: Event): void {
    this.value.set(this.val(e));
  }

  protected doImport(): void {
    const v = this.value().trim();
    if (!v || this.loading()) return;
    const request = toImportRequest(v);
    this.sourceUrl = request.url;
    this.error.set(null);
    this.loading.set(true);
    this.api.importRecipe(request).subscribe({
      next: (res) => this.onResult(res),
      error: (err: unknown) => {
        this.loading.set(false);
        this.error.set(this.messageFor(err));
        setTimeout(() => this.box()?.nativeElement.focus());
      },
    });
  }

  private onResult(res: ImportResult): void {
    this.loading.set(false);
    const recipe = { ...res.draft.recipe };
    if (this.sourceUrl && !recipe.sourceUrl) recipe.sourceUrl = this.sourceUrl;
    this.draft.set({ ...res.draft, recipe });
    this.imageUrl.set(res.imageUrl);
  }

  private messageFor(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      if (err.status === 429) return RATE_LIMIT_MESSAGE;
      if (err.status === 422) {
        const code = (err.error as { error?: string } | null)?.error as ImportErrorCode | undefined;
        const msg = (code && IMPORT_ERROR_MESSAGES[code]) ?? GENERIC_ERROR_MESSAGE;
        return `${msg} ${FALLBACK}`;
      }
    }
    return GENERIC_ERROR_MESSAGE;
  }

  // ---- preview helpers ----

  protected metric(i: Ingredient): string {
    return formatQuantity(i, 'metric');
  }

  protected original(i: Ingredient): string {
    return i.original ?? formatQuantity(i, 'original');
  }

  private patch(fn: (r: RecipeDraft['recipe']) => RecipeDraft['recipe']): void {
    this.draft.update((d) => (d ? { ...d, recipe: fn(d.recipe) } : d));
  }

  protected setTitle(e: Event): void {
    const title = this.val(e);
    this.patch((r) => ({ ...r, title }));
  }

  protected setServings(e: Event): void {
    const n = Number(this.val(e));
    if (Number.isFinite(n) && n >= 1) this.patch((r) => ({ ...r, servings: Math.round(n) }));
  }

  protected removeIngredient(index: number): void {
    this.patch((r) => ({ ...r, ingredients: r.ingredients.filter((_, i) => i !== index) }));
  }

  protected addIngredient(): void {
    const line = this.newIngredient().trim();
    if (!line) return;
    this.patch((r) => ({ ...r, ingredients: [...r.ingredients, parseIngredient(line)] }));
    this.newIngredient.set('');
  }

  protected setStep(index: number, e: Event): void {
    const v = this.val(e);
    this.patch((r) => ({ ...r, steps: r.steps.map((s, i) => (i === index ? v : s)) }));
  }

  protected removeStep(index: number): void {
    this.patch((r) => ({ ...r, steps: r.steps.filter((_, i) => i !== index) }));
  }

  protected addStep(): void {
    this.patch((r) => ({ ...r, steps: [...r.steps, ''] }));
  }

  protected save(): void {
    const d = this.draft();
    if (!d || this.saving()) return;
    const rest = d.recipe;
    const input: RecipeInput = {
      ...rest,
      title: rest.title.trim() || 'Untitled recipe',
      steps: rest.steps.filter((s) => s.trim()),
    };
    this.saving.set(true);
    this.error.set(null);
    this.api.createRecipe(input).subscribe({
      next: (created) => void this.router.navigate(['/recipes', created.id]),
      error: () => {
        this.saving.set(false);
        this.error.set("Couldn't save the recipe. Try again.");
      },
    });
  }

  protected discard(): void {
    void this.router.navigate(['/recipes']);
  }
}

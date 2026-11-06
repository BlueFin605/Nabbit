import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, signal, viewChild, type ElementRef, type OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { RecipeEditor } from '../recipes/recipe-editor';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
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
  not_image: "That image can't be used.",
  too_many_redirects: 'That link redirects too many times.',
  needs_text: "Instagram wouldn't let us read this post. Paste the caption (and the recipe comment if it's in the comments).",
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
  imports: [RecipeEditor, MatButtonModule, MatFormFieldModule, MatInputModule, MatProgressSpinnerModule],
  styles: `
    :host { display: block; }
    .box { width: 100%; }
    .banner { padding: 12px 16px; border-radius: 12px; margin: 12px 0; background: var(--mat-sys-tertiary-container, #fde7b0); }
    .error { color: var(--mat-sys-error, #b3261e); margin: 8px 0; }
    .loading { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
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
        <app-recipe-editor
          [recipe]="d.recipe"
          [previewImage]="chosenCandidate()"
          [candidates]="candidates()"
          (candidateChosen)="onCandidate($event)"
          [saving]="saving()"
          [error]="error()"
          (saved)="save($event)"
          (cancelled)="discard()"
        />
      }
    }
  `,
})
export class Import implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly snack = inject(MatSnackBar);

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
  protected readonly candidates = signal<string[]>([]);
  /** The photo that will be fetched on save; undefined once the user supplies or removes their own. */
  protected readonly chosenCandidate = signal<string | undefined>(undefined);
  protected readonly isEmpty = computed(() => {
    const d = this.draft();
    return !!d && d.recipe.ingredients.length === 0 && d.recipe.steps.length === 0;
  });

  private sourceUrl: string | undefined;
  /** Key returned by images/import for a candidate, kept so a Save retry does not re-fetch. */
  private fetched: { candidate: string; imageKey: string } | undefined;

  protected onCandidate(c: string | undefined): void {
    if (c !== this.fetched?.candidate) this.fetched = undefined;
    this.chosenCandidate.set(c);
  }

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
    // Always offer the found photo(s) so they can be re-picked after declining.
    this.candidates.set(res.candidates?.length ? res.candidates : res.imageUrl ? [res.imageUrl] : []);
    this.fetched = undefined;
    this.chosenCandidate.set(res.candidates?.[0] ?? res.imageUrl);
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

  protected save(input: RecipeInput): void {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    const chosen = this.chosenCandidate();
    if (input.imageKey || !chosen) {
      this.create(input);
      return;
    }
    if (this.fetched?.candidate === chosen) {
      this.create({ ...input, imageKey: this.fetched.imageKey });
      return;
    }
    this.api.importImage(chosen).subscribe({
      next: ({ imageKey }) => {
        this.fetched = { candidate: chosen, imageKey };
        this.create({ ...input, imageKey });
      },
      error: () => {
        this.snack.open('Saved without a photo - add one in the editor.', 'OK', { duration: 6000 });
        this.create(input);
      },
    });
  }

  private create(input: RecipeInput): void {
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

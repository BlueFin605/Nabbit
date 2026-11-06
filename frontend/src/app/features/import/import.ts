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
import { environment } from '../../../environments/environment';
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

const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am']);

/** True for a URL whose hostname (one trailing dot ignored) is exactly instagram.com / www. / m. / instagr.am. */
export function isInstagramUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return INSTAGRAM_HOSTS.has(host) || (environment.extraInstagramHosts ?? []).includes(host);
  } catch {
    return false;
  }
}

const IG_POST_PATH = /^\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/;

/**
 * Canonical form of an Instagram URL so share params (igsh, igshid, utm_source, rpxt, srtk...) are never sent or saved:
 * a post URL becomes https://www.instagram.com/{p|reel|reels|tv}/{id}/, any other URL loses its query and fragment.
 * Mirrors the backend `canonicalInstagramUrl`.
 */
export function canonicalInstagramUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    const m = IG_POST_PATH.exec(u.pathname);
    if (m && INSTAGRAM_HOSTS.has(host)) return `https://www.instagram.com/${m[1]}/${m[2]}/`;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** Appends items of `extra` whose lower-cased text is not already in `base`. */
function appendNew<T>(base: T[], extra: T[], key: (t: T) => string): T[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const seen = new Set(base.map((t) => norm(key(t))));
  const out = [...base];
  for (const t of extra) {
    const k = norm(key(t));
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/** Adds the ingredients and steps of `extra` to `base`, skipping duplicates (same lower-cased text). Confidence is 'ai' if either side is. */
export function mergeDrafts(base: RecipeDraft, extra: RecipeDraft): RecipeDraft {
  return {
    ...base,
    confidence: base.confidence === 'ai' || extra.confidence === 'ai' ? 'ai' : base.confidence,
    recipe: {
      ...base.recipe,
      ingredients: appendNew(base.recipe.ingredients, extra.recipe.ingredients, (i) => i.original ?? i.name),
      steps: appendNew(base.recipe.steps, extra.recipe.steps, (st) => st),
    },
  };
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
    .info { padding: 12px 16px; border-radius: 12px; margin: 8px 0; background: var(--mat-sys-secondary-container, #e8def8); }
    .comment-appender { margin: 16px 0; }
    .hint { margin: 4px 0 8px; }
    .comment-appender summary { cursor: pointer; margin-bottom: 8px; }
    .error { color: var(--mat-sys-error, #b3261e); margin: 8px 0; }
    .loading { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
  `,
  template: `
    <h1>Import a recipe</h1>

    @if (!draft()) {
      <mat-form-field class="box" appearance="outline">
        <mat-label>{{ needsText() ? 'Paste the caption' : 'Paste a link or recipe text' }}</mat-label>
        <textarea #box matInput rows="4" [value]="value()" (input)="onInput($event)"></textarea>
      </mat-form-field>

      @if (info(); as i) {
        <p class="info" role="status">{{ i }}</p>
      }

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
        @if (d.confidence === 'ai') {
          <p class="banner" role="note">AI-assisted - check the ingredients</p>
        }
        @if (isEmpty()) {
          <p class="banner" role="note">We couldn't find a recipe there. Fill it in yourself — the source link is kept.</p>
        }
        @if (igSource()) {
          <details class="comment-appender">
            <summary>Recipe in a comment? Paste it here to add it</summary>
            <mat-form-field class="box" appearance="outline">
              <mat-label>Paste the comment</mat-label>
              <textarea matInput rows="4" [value]="comment()" (input)="onComment($event)"></textarea>
            </mat-form-field>
            @if (editorDirty()) {
              <p class="hint" role="note">You've edited the recipe below. Save or discard your edits before adding a comment, or they would be lost.</p>
            }
            <button mat-stroked-button type="button" class="add-comment" [disabled]="loading() || !comment().trim() || editorDirty()" (click)="addComment()">
              Add and re-import
            </button>
            @if (error(); as e) {
              <p class="error" role="alert">{{ e }}</p>
            }
          </details>
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
  private readonly editor = viewChild(RecipeEditor);
  /** The editor resets when the draft changes, so the appender is off while the user has unsaved edits. */
  protected readonly editorDirty = computed(() => this.editor()?.dirty() ?? false);

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

  /** Non-error guidance shown above the box (the needs_text paste prompt). */
  protected readonly info = signal<string | null>(null);
  /** True after a needs_text response: the box now expects the pasted caption. */
  protected readonly needsText = signal(false);
  /** True when the import came from an Instagram URL or a needs_text flow: offer the comment appender. */
  protected readonly igSource = signal(false);
  protected readonly comment = signal('');

  private sourceUrl: string | undefined;
  /** URL remembered across a needs_text round trip, applied as sourceUrl once the pasted text imports. */
  private pendingUrl: string | undefined;
  /** Caption the user pasted (needs_text or paste flow); unknown when the server auto-fetched it. */
  private caption: string | undefined;
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
    // After needs_text the box holds a caption, sent as text even if it starts with https://. The exception is
    // a single non-Instagram https URL: the user gave up on the caption and pasted another link, so import it normally.
    if (this.needsText() && /^https:\/\/\S+$/i.test(v) && !isInstagramUrl(v)) {
      this.needsText.set(false);
      this.pendingUrl = undefined;
    }
    let request: ImportRequest = this.needsText() ? { text: v } : toImportRequest(v);
    if (request.url && isInstagramUrl(request.url)) request = { url: canonicalInstagramUrl(request.url) };
    this.sourceUrl = request.url ?? this.pendingUrl;
    this.caption = request.text;
    this.igSource.set(isInstagramUrl(request.url) || this.needsText());
    this.run(request, 'fresh');
  }

  private run(request: ImportRequest, mode: 'fresh' | 'replace' | 'merge'): void {
    this.error.set(null);
    this.info.set(null);
    this.loading.set(true);
    this.api.importRecipe(request).subscribe({
      next: (res) => {
        this.needsText.set(false);
        this.onResult(res, mode);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        if (mode === 'fresh' && this.isNeedsText(err)) {
          this.pendingUrl = request.url ?? this.pendingUrl;
          this.needsText.set(true);
          this.value.set('');
          this.info.set(IMPORT_ERROR_MESSAGES.needs_text);
        } else {
          this.error.set(this.messageFor(err));
        }
        if (mode === 'fresh') setTimeout(() => this.box()?.nativeElement.focus());
      },
    });
  }

  protected onComment(e: Event): void {
    this.comment.set(this.val(e));
  }

  /**
   * Known caption (pasted here): re-imports caption + comment and REPLACES the draft with the result (spec 2c).
   * Unknown caption (auto-fetched server-side): imports just the comment and MERGES it into the preview,
   * appending new ingredients and steps and skipping duplicates (same lower-cased text).
   */
  protected addComment(): void {
    const c = this.comment().trim();
    if (!c || this.loading()) return;
    if (this.caption) this.run({ text: `${this.caption}

${c}` }, 'replace');
    else this.run({ text: c }, 'merge');
  }

  private isNeedsText(err: unknown): boolean {
    return err instanceof HttpErrorResponse && err.status === 422 && (err.error as { error?: string } | null)?.error === 'needs_text';
  }

  private onResult(res: ImportResult, mode: 'fresh' | 'replace' | 'merge'): void {
    this.loading.set(false);
    const existing = this.draft();
    const incoming = mode === 'merge' && existing ? mergeDrafts(existing, res.draft) : res.draft;
    const recipe = { ...incoming.recipe };
    if (this.sourceUrl && !recipe.sourceUrl) recipe.sourceUrl = this.sourceUrl;
    this.draft.set({ ...incoming, recipe });
    this.comment.set('');
    if (mode !== 'fresh') return; // keep the photo choice the user already has
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

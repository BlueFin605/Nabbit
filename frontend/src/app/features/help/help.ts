import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';
import { renderHelpMarkdown } from './help-markdown';

export interface HelpTopic {
  slug: string;
  title: string;
  file: string;
}

/** In-app help: topic list at /help, a rendered guide at /help/:topic. Guides are built from docs/help (see scripts/help-index.mjs). */
@Component({
  selector: 'app-help',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host { display: block; max-width: 48rem; margin: 0 auto; padding: 16px; }
    ul.topics { list-style: none; padding: 0; margin: 0; }
    ul.topics a { display: block; padding: 12px 0; }
    :host ::ng-deep .help-body img { max-width: 100%; height: auto; }
  `,
  template: `
    @if (error()) {
      <p class="help-error" role="alert">{{ error() }}</p>
    } @else if (topics() === null) {
      <p class="help-loading">Loading help…</p>
    } @else if (!topic()) {
      <h1>Help</h1>
      <nav aria-label="Help topics">
        <ul class="topics">
          @for (t of topics(); track t.slug) {
            <li><a [routerLink]="['/help', t.slug]">{{ t.title }}</a></li>
          }
        </ul>
      </nav>
    } @else {
      <p><a routerLink="/help">&larr; All help topics</a></p>
      @if (html(); as h) {
        <article class="help-body" [innerHTML]="h"></article>
      } @else {
        <p class="help-loading">Loading help…</p>
      }
    }
  `,
})
export class Help {
  private readonly http = inject(HttpClient);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly router = inject(Router);

  /** Bound from the `:topic` route param. */
  readonly topic = input<string | undefined>();

  protected readonly topics = signal<HelpTopic[] | null>(null);
  protected readonly html = signal<SafeHtml | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.http.get<HelpTopic[]>('assets/help-index.json').subscribe({
      next: (t) => this.topics.set(t),
      error: () => this.error.set('Help could not be loaded'),
    });

    effect((onCleanup) => {
      const list = this.topics();
      const slug = this.topic();
      this.html.set(null);
      if (!list || !slug) return;
      const found = list.find((t) => t.slug === slug);
      if (!found) {
        void this.router.navigateByUrl('/help', { replaceUrl: true });
        return;
      }
      const sub = this.http.get('assets/help/' + found.file, { responseType: 'text' }).subscribe({
        // renderHelpMarkdown escapes raw HTML and attribute values itself; Angular's sanitizer would add nothing.
        next: (md) => this.html.set(this.sanitizer.bypassSecurityTrustHtml(renderHelpMarkdown(md))),
        error: () => this.error.set('Help could not be loaded'),
      });
      onCleanup(() => sub.unsubscribe());
    });
  }
}

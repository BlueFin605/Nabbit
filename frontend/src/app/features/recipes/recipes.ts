import { Component, DestroyRef, computed, inject, signal, type OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Subject, catchError, debounceTime, map, of, startWith, switchMap } from 'rxjs';
import { ApiClient } from '../../core/api/api-client';
import type { RecipeSummary } from '../../core/api/api.types';
import { imageUrl } from '../../core/api/image-url';

export const SEARCH_DEBOUNCE_MS = 250;

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ok'; recipes: RecipeSummary[] };

/** Recipe list: card grid with debounced search and tag filter chips. */
@Component({
  selector: 'app-recipes',
  imports: [RouterLink, MatButtonModule, MatChipsModule, MatFormFieldModule, MatInputModule],
  styleUrl: './recipes.scss',
  template: `
    <h1>Recipes</h1>

    <mat-form-field class="search" appearance="outline" subscriptSizing="dynamic">
      <mat-label>Search recipes</mat-label>
      <input matInput type="search" [value]="q()" (input)="onSearch($event)" />
    </mat-form-field>

    @if (allTags().length > 0) {
      <mat-chip-listbox class="tags" aria-label="Filter by tag">
        @for (t of allTags(); track t) {
          <mat-chip-option [selected]="tag() === t" (click)="toggleTag(t)">{{ t }}</mat-chip-option>
        }
      </mat-chip-listbox>
    }

    @switch (load().status) {
      @case ('loading') {
        <div class="grid" aria-busy="true" aria-label="Loading recipes">
          @for (n of skeletons; track n) {
            <div class="card skeleton"><div class="photo"></div><div class="body"><div class="bar"></div></div></div>
          }
        </div>
      }
      @case ('error') {
        <div class="state" role="alert">
          <p>Couldn't load your recipes.</p>
          <button mat-flat-button type="button" (click)="refresh()">Retry</button>
        </div>
      }
      @default {
        @if (recipes().length === 0) {
          <p class="state empty">
            @if (q() || tag()) {
              No recipes match.
            } @else {
              No recipes yet — tap + to add one
            }
          </p>
        } @else {
          <div class="grid">
            @for (r of recipes(); track r.id) {
              <a class="card" [routerLink]="['/recipes', r.id]">
                @if (r.imageKey) {
                  <img class="photo" [src]="imageSrc(r.imageKey)" alt="" loading="lazy" />
                } @else {
                  <div class="photo placeholder" aria-hidden="true">🍽</div>
                }
                <div class="body">
                  <h2>{{ r.title }}</h2>
                  @if (r.tags.length > 0) {
                    <ul class="card-tags">
                      @for (t of r.tags; track t) {
                        <li>{{ t }}</li>
                      }
                    </ul>
                  }
                </div>
              </a>
            }
          </div>
        }
      }
    }

    <button mat-fab class="fab" type="button" aria-label="Add recipe" (click)="add()">+</button>
  `,
})
export class Recipes implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly skeletons = [1, 2, 3, 4];
  protected readonly q = signal('');
  protected readonly tag = signal<string | null>(null);
  protected readonly load = signal<Load>({ status: 'loading' });
  /** Every tag seen so far, so chips stay put while a tag filter narrows the list. */
  private readonly seenTags = signal<ReadonlySet<string>>(new Set());

  protected readonly recipes = computed(() => {
    const l = this.load();
    return l.status === 'ok' ? l.recipes : [];
  });
  protected readonly allTags = computed(() => [...this.seenTags()].sort((a, b) => a.localeCompare(b)));

  private readonly search$ = new Subject<string>();
  private readonly request$ = new Subject<void>();

  constructor() {
    this.search$.pipe(debounceTime(SEARCH_DEBOUNCE_MS), takeUntilDestroyed()).subscribe((value) => {
      this.q.set(value.trim());
      this.refresh();
    });

    this.request$
      .pipe(
        switchMap(() =>
          this.api.listRecipes({ q: this.q() || undefined, tag: this.tag() ?? undefined }).pipe(
            map((recipes): Load => ({ status: 'ok', recipes })),
            catchError(() => of<Load>({ status: 'error' })),
            startWith<Load>({ status: 'loading' }),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((l) => {
        this.load.set(l);
        if (l.status === 'ok') {
          this.seenTags.update((s) => new Set([...s, ...l.recipes.flatMap((r) => r.tags)]));
        }
      });
  }

  ngOnInit(): void {
    this.refresh();
  }

  protected refresh(): void {
    this.request$.next();
  }

  protected onSearch(event: Event): void {
    this.search$.next((event.target as HTMLInputElement).value);
  }

  protected toggleTag(t: string): void {
    this.tag.set(this.tag() === t ? null : t);
    this.refresh();
  }

  protected imageSrc(key: string): string {
    return imageUrl(key);
  }

  protected add(): void {
    void this.router.navigate(['/import']);
  }
}

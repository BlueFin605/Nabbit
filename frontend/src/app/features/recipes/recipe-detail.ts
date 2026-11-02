import { Component, DestroyRef, computed, inject, input, signal, type OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { convertTemperatures, formatQuantity, scaleRecipeIngredients, type Ingredient } from '@nabbit/recipe-core';
import { ApiClient } from '../../core/api/api-client';
import type { Recipe } from '../../core/api/api.types';
import { imageUrl } from '../../core/api/image-url';

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

          <h2>Ingredients</h2>
          <ul class="ingredients">
            @for (line of lines(); track line.id) {
              <li [class.fixed]="line.fixed">
                <span class="qty">{{ line.text }}</span>
                @if (line.note) {
                  <span class="note">, {{ line.note }}</span>
                }
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
          </div>
        }
      }
    }
  `,
})
export class RecipeDetail implements OnInit {
  private readonly api = inject(ApiClient);
  private readonly destroyRef = inject(DestroyRef);

  /** Bound from the `:id` route param via withComponentInputBinding. */
  readonly id = input<string>();

  protected readonly min = MIN_SERVINGS;
  protected readonly max = MAX_SERVINGS;
  protected readonly load = signal<Load>({ status: 'loading' });
  protected readonly mode = signal<Mode>(readMode());
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

  protected readonly lines = computed(() =>
    this.scaledIngredients().map((i) => ({
      id: i.id,
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

  protected imageSrc(key: string): string {
    return imageUrl(key);
  }

  protected step(delta: number): void {
    this.chosen.set(Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, this.servings() + delta)));
  }

  protected setMode(mode: Mode): void {
    this.mode.set(mode);
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

  /** Hook for the add-to-list dialog (separate ticket); it will receive `scaledIngredients()`. */
  protected addToList(): void {
    // Intentionally empty until the add-to-list dialog ticket lands.
  }
}

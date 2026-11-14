import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  convertTemperatures,
  formatQuantity,
  mapSteps,
  type StepGroup,
  type StepNode,
} from '@nabbit/recipe-core';
import type { RecipeInput } from '../../core/api/api.types';

/** The fields the view needs; satisfied by a saved recipe and by an unsaved draft (no id/version). */
export type RecipeViewModel = Pick<RecipeInput, 'title' | 'ingredients' | 'steps'> &
  Partial<Pick<RecipeInput, 'sourceUrl' | 'tags'>>;

/**
 * Presentational recipe content: photo, title, ingredients, nested steps, tags and source.
 * No API or router. Ingredients are shown as given (the caller scales them). Scale controls and other
 * interactive extras are projected into the `[controls]` slot by the caller.
 */
@Component({
  selector: 'app-recipe-view',
  imports: [NgTemplateOutlet, MatButtonModule],
  styleUrl: './recipe-view.scss',
  template: `
    @if (imageUrl(); as src) {
      <img class="photo" [src]="src" alt="" />
    }
    <h1>{{ recipe().title }}</h1>
    @if (readOnly() && recipe().tags?.length) {
      <ul class="tags" aria-label="Tags">
        @for (t of recipe().tags; track t) {
          <li>{{ t }}</li>
        }
      </ul>
    }

    <ng-content select="[controls]" />

    <h2>Ingredients</h2>
    <ul class="ingredients">
      @for (line of lines(); track line.id) {
        <li [class.fixed]="line.fixed">
          <span class="qty">{{ line.text }}</span>
          @if (line.note) {
            <span class="note">, {{ line.note }}</span>
          }
          @if (!readOnly()) {
            <button
              mat-icon-button
              type="button"
              class="add-one"
              [attr.aria-label]="'Add ' + line.name + ' to shopping list'"
              (click)="addOne.emit(line.id)"
            >
              <span aria-hidden="true">{{ added().has(line.id) ? '✓' : '+' }}</span>
            </button>
          }
        </li>
      }
    </ul>

    <h2>Steps</h2>
    <ol class="steps">
      <ng-container *ngTemplateOutlet="stepList; context: { $implicit: steps() }" />
    </ol>

    @if (recipe().sourceUrl; as url) {
      <p class="source"><a [href]="url" target="_blank" rel="noopener noreferrer">Source</a></p>
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
export class RecipeView {
  readonly recipe = input.required<RecipeViewModel>();
  /** Resolved photo URL (e.g. a preview of an unsaved draft's image). */
  readonly imageUrl = input<string>();
  /** Hides the shopping-list buttons (and shows tags). Default true. */
  readonly readOnly = input(true);
  readonly mode = input<'metric' | 'original'>('metric');
  /** Ingredient ids to show as already added to the list. */
  readonly added = input<ReadonlySet<string>>(new Set());
  readonly addOne = output<string>();

  protected readonly lines = computed(() =>
    this.recipe().ingredients.map((i) => ({
      id: i.id,
      name: i.name,
      text: formatQuantity(i, this.mode()),
      note: i.note,
      fixed: !i.scalable,
    })),
  );
  protected readonly steps = computed((): StepNode[] => {
    const steps = this.recipe().steps;
    return this.mode() === 'metric' ? mapSteps(steps, convertTemperatures) : steps;
  });

  protected isString(n: StepNode): n is string {
    return typeof n === 'string';
  }

  /** Narrows a non-string node inside the recursive (untyped `let-nodes`) template context. */
  protected asGroup(n: StepNode): StepGroup {
    return n as StepGroup;
  }
}

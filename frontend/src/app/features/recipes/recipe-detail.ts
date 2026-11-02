import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Single recipe view. Placeholder; the real screen arrives in a later ticket. */
@Component({
  selector: 'app-recipe-detail',
  imports: [RouterLink],
  template: `
    <a routerLink="/recipes">Back to recipes</a>
    <h1>Recipe</h1>
    <p>Recipe {{ id() }}</p>
  `,
})
export class RecipeDetail {
  /** Bound from the `:id` route param via withComponentInputBinding. */
  readonly id = input<string>();
}

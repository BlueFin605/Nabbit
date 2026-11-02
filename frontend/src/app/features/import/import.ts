import { Component, input } from '@angular/core';

/**
 * Recipe import. Also the Web Share Target landing page: the manifest sends GET /import?title=&text=&url=
 * Placeholder; the real screen arrives in a later ticket.
 */
@Component({
  selector: 'app-import',
  template: `
    <h1>Import a recipe</h1>
    @if (url() || text() || title()) {
      <p>Shared: {{ title() }} {{ url() }} {{ text() }}</p>
    }
  `,
})
export class Import {
  readonly title = input<string>();
  readonly text = input<string>();
  readonly url = input<string>();
}

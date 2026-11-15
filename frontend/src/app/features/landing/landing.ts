import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';

/** Public landing page shown at `/` to signed-out visitors (content is filled in by NAB-184). */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, MatButtonModule],
  template: `
    <section class="landing">
      <h1>Nabbit</h1>
      <p>Your recipes and shopping lists, in one place.</p>
      <a mat-flat-button routerLink="/signin" class="signin-btn">Sign in</a>
    </section>
  `,
  styles: `
    .landing {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 15vh 16px 0;
      text-align: center;
    }
  `,
})
export class Landing {}

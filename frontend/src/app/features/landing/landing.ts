import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';

interface Feature {
  /** SVG path data (24x24, stroked) for features; the step number for steps. */
  icon: string;
  title: string;
  text: string;
  shot?: { src: string; alt: string };
}

interface Faq {
  q: string;
  a: string;
}

/** Public landing page shown at `/` to signed-out visitors. */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, MatButtonModule, MatExpansionModule],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
})
export class Landing {
  protected readonly features: Feature[] = [
    {
      icon: 'M12 3v12M7 10l5 5 5-5M4 20h16',
      title: 'Import recipes',
      text: 'Paste a web link or the recipe text, or bring one in from an Instagram post or a YouTube video. If a site or post cannot be read automatically, paste the text instead.',
      shot: { src: 'assets/screens/import.png', alt: 'The Nabbit import screen with a recipe link ready to import' },
    },
    {
      icon: 'M12 4v16M7 20h10M3 8h18M6 8l-3 7a3.5 3.5 0 0 0 6 0zM18 8l-3 7a3.5 3.5 0 0 0 6 0z',
      title: 'Scale by ingredient',
      text: 'Change the servings, or pick the ingredient you have and scale everything else to match. Metric by default.',
      shot: { src: 'assets/screens/scale.png', alt: 'A Sunday Lasagne recipe scaled to six servings, with a Scale by menu and metric units' },
    },
    {
      icon: 'M3 4h2l2.4 11h10l2-8H6M9 20h.01M17 20h.01',
      title: 'Shopping lists',
      text: "Add a recipe's ingredients, already scaled, to a shopping list.",
      shot: { src: 'assets/screens/lists.png', alt: 'A Nabbit shopping list with items ready to tick off' },
    },
    {
      icon: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM12 7v7M9 11l3 3 3-3',
      title: 'Install as an app',
      text: 'Add Nabbit to your phone or desktop home screen. It opens full screen like any other app.',
    },
    {
      icon: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
      title: 'Android share',
      text: 'On Android, share a link from your browser or another app straight into Nabbit to import it.',
    },
  ];

  protected readonly steps: Feature[] = [
    { icon: '1', title: 'Bring a recipe in', text: 'Paste a link or text, or share it from your phone.' },
    { icon: '2', title: 'Check and save', text: 'Review the preview, fix anything that was misread, then save it to your collection.' },
    { icon: '3', title: 'Cook and shop', text: 'Scale it to the size you need and add the ingredients to a shopping list.' },
  ];

  protected readonly faqs: Faq[] = [
    {
      q: 'What is Nabbit?',
      a: 'Nabbit is a personal recipe and shopping-list app. You import recipes, keep them in one place, scale them and turn them into shopping lists.',
    },
    {
      q: 'Is it free?',
      a: 'Yes. Nabbit is a personal project and has no charge.',
    },
    {
      q: 'How do I get an account?',
      a: 'Choose Sign in, then create an account on the sign-in page (or continue with Google if offered). Each person has their own private recipes and lists.',
    },
    {
      q: "Why can't I import from some sites?",
      a: 'Some sites, and many Instagram and YouTube posts, only show their content to logged-in visitors or build the page in a way that cannot be read automatically. When that happens Nabbit asks you to paste the recipe text (an Instagram caption, a video transcript) and imports that instead.',
    },
    {
      q: 'How do I install it?',
      a: 'In Chrome or Edge, use the install icon in the address bar or the browser menu. On Android, choose Add to Home screen or Install app. On iPhone, open the Share menu in Safari and choose Add to Home Screen.',
    },
    {
      q: 'Where is my data?',
      a: 'Your recipes, photos and lists are stored in a private account on AWS in Sydney. They are tied to your sign-in and are not shown to other users.',
    },
  ];
}

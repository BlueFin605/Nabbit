import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';

interface Feature {
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
  imports: [RouterLink, MatButtonModule, MatExpansionModule, MatIconModule],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
})
export class Landing {
  protected readonly features: Feature[] = [
    {
      icon: 'cloud_download',
      title: 'Import recipes',
      text: 'Paste a web link or the recipe text, or bring one in from an Instagram post or a YouTube video. If a site or post cannot be read automatically, paste the text instead.',
      shot: { src: 'assets/screens/import.png', alt: 'The Nabbit import screen with a recipe link ready to import' },
    },
    {
      icon: 'balance',
      title: 'Scale by ingredient',
      text: 'Change the servings, or pick the ingredient you have and scale everything else to match. Metric by default.',
      shot: { src: 'assets/screens/scale.png', alt: 'A Sunday Lasagne recipe scaled to six servings, with a Scale by menu and metric units' },
    },
    {
      icon: 'shopping_cart',
      title: 'Shopping lists',
      text: "Add a recipe's ingredients, already scaled, to a shopping list.",
      shot: { src: 'assets/screens/lists.png', alt: 'A Nabbit shopping list with items ready to tick off' },
    },
    {
      icon: 'install_mobile',
      title: 'Install as an app',
      text: 'Add Nabbit to your phone or desktop home screen. It opens full screen like any other app.',
    },
    {
      icon: 'share',
      title: 'Android share',
      text: 'On Android, share a link from your browser or another app straight into Nabbit to import it.',
    },
  ];

  protected readonly steps: Feature[] = [
    { icon: 'looks_one', title: 'Bring a recipe in', text: 'Paste a link or text, or share it from your phone.' },
    { icon: 'looks_two', title: 'Check and save', text: 'Review the preview, fix anything that was misread, then save it to your collection.' },
    { icon: 'looks_3', title: 'Cook and shop', text: 'Scale it to the size you need and add the ingredients to a shopping list.' },
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

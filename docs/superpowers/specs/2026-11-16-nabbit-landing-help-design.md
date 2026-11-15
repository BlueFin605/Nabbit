# Nabbit landing page and in-app help — design

Date: 2026-11-16
Branch: `feature/landing-help` (Nabbit), Home tile on `feature/app-landing-pages`

## Goal

A visitor who browses to `nabbit.bluefin605.com` for the first time sees what
Nabbit is, a clear path to sign in, and an FAQ — not a bare Cognito login.
Signed-in users get help pages inside the app.

This supersedes the Nabbit part of
`Home/docs/superpowers/specs/2026-11-07-app-landing-pages-design.md`
(static `website/nabbit/` pages are dropped; only a Home grid tile remains).

## Decisions

| Question | Decision |
|----------|----------|
| Where does the landing page live? | In the Nabbit app, public route `/`, so direct visitors know where they are |
| Where does help live? | In the Nabbit app, behind `authGuard` (signed-in only), reachable from the landing page via sign-in redirect |
| Home site | Only a Nabbit tile in `website/index.html` linking to `https://nabbit.bluefin605.com/` |

## Routes (frontend)

- `/` — public. Unauthenticated visitor sees the landing page. Signed-in user
  is redirected to `/recipes`.
- `/signin`, `/callback` — unchanged (`/signin` still auto-redirects to the Hosted UI).
- `/help`, `/help/:topic` — behind `authGuard`. The guard already remembers
  the target URL, so landing "Help" -> sign in -> back to `/help`.
- Deep links (`/recipes/:id`, `/lists`, `/import`) still go to sign-in.
- Replaces the `'' -> recipes` redirect.

## Landing page

- Hero: one-line pitch, primary **Sign in / Get started** button (-> `/signin`), screenshot.
- Feature grid: import (URL, pasted text, Instagram, YouTube), scale by
  ingredient, shopping lists, install as an app, Android share target.
- "How it works": three steps.
- FAQ (collapsible): what is it, is it free, how do I get an account, why
  can't I import from some sites, how do I install it, where is my data.
- Footer: Help link (requires sign-in).
- Prospects cannot read help before signing in, so the landing page must carry
  the what/how content itself.
- Honesty: URL import is disabled in prod (`importReservedConcurrency: 0`).
  Copy must match what is live when it ships.

## Help

- Markdown guides in `Nabbit/docs/help/`, rendered with `marked`, using the
  FullyRested pattern (prebuild index script copying to git-ignored
  `src/assets/help/` plus `help-index.json`).
- Topics: Getting started, Installing the app, Importing a recipe (URL, text,
  Instagram/YouTube, Android share), Scaling, Shopping lists, Troubleshooting.
- Renders in the normal app shell; Help entry in the avatar menu.

## Screenshots

Playwright capture against the local e2e stack with seeded demo data; PNGs
committed under frontend assets and shared by landing page and help.

## Home tile

Card in `Home/website/index.html` (before the "Add more" comment) linking to
`https://nabbit.bluefin605.com/`; accent from existing `assets/nabbit.css`.

## Verification

Unit/e2e: `/` shows landing when unauthenticated and redirects when signed
in; `/help` redirects to sign-in when unauthenticated; deep links unchanged.
Visual check at desktop and phone width, light and dark. `ng lint` before close.

## Docs impact

`Nabbit/SYSDOC.md`: new public route, help pipeline. `Home/SYSDOC.md`: website
has the tile only. API impact: none (frontend only).

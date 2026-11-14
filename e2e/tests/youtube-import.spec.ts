import { expect, test } from '../fixtures/api';
import type { Page } from '@playwright/test';

// Needs the stack's dev-only hooks: yt.nabbit-fixtures.test counts as YouTube (NABBIT_E2E_YOUTUBE_HOSTS on the backend,
// extraYoutubeHosts in the e2e frontend build) and is served from e2e/fixtures/site/yt/<id>.html (watch pages) and
// captions/ (caption tracks); NABBIT_E2E_FAKE_LLM=1 answers for [[fake-llm]] / [[fake-not-recipe]] text.
const yt = (id: string) => `https://yt.nabbit-fixtures.test/watch?v=${id}`;
const LINKED = yt('YTlinked001'); // description links to the pasta fixture; also has captions
const TRANSCRIPT = yt('YTtransc001'); // no usable link, captions containing [[fake-llm]]
const NO_CAPTIONS = yt('YTnocapt001');
const VLOG = yt('YTvlog00001'); // captions containing [[fake-not-recipe]]
const PASTA = 'https://nabbit-fixtures.test/pasta.html';
const TRANSCRIPT_TEXT = 'We make a cosy soup [[fake-llm]] with stock, onion and carrots. Chop, simmer, serve hot.';

async function startImport(page: Page, url: string) {
  await page.goto('/import');
  await page.getByLabel('Paste a link or recipe text').fill(url);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
}

const sourceBanner = (page: Page) => page.locator('.source-banner');

test.describe('journey 12: YouTube import', () => {
  test('a linked recipe page wins, shows the banner and saves with the recipe page as source', async ({ page, api }) => {
    await startImport(page, LINKED);
    await expect(page.getByRole('heading', { level: 1, name: 'Lemon Pasta' })).toBeVisible();
    await expect(sourceBanner(page)).toContainText('Imported from the recipe page linked in the video');
    await expect(page.getByRole('button', { name: 'Use the video transcript instead' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Watch the video' })).toHaveAttribute('href', LINKED);
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.locator('button.save').first().click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const recipes = await api.recipes();
    expect(recipes.map((r) => r.title)).toEqual(['Lemon Pasta']);
    expect((await api.recipe(recipes[0].id)).sourceUrl).toBe(PASTA);
  });

  test('"Use the video transcript instead" swaps in the AI transcript draft with flat steps', async ({ page, api }) => {
    await startImport(page, LINKED);
    await expect(page.getByRole('heading', { level: 1, name: 'Lemon Pasta' })).toBeVisible();
    await page.getByRole('button', { name: 'Use the video transcript instead' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Fake AI Soup' })).toBeVisible();
    await expect(sourceBanner(page)).toContainText('From the video transcript - check quantities');
    await expect(page.getByRole('note').filter({ hasText: 'AI-assisted - check the ingredients' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use the video transcript instead' })).toHaveCount(0);
    await expect(page.locator('ol.steps li')).toHaveCount(3);
    await expect(page.locator('ol.steps li ol, ol.steps li ul')).toHaveCount(0);

    // Preview Save from the top bar
    await page.locator('button.save').first().click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const recipes = await api.recipes();
    expect(recipes.map((r) => r.title)).toEqual(['Fake AI Soup']);
    expect((await api.recipe(recipes[0].id)).sourceUrl).toBe(LINKED);
  });

  test('a video with no link imports straight from its transcript', async ({ page }) => {
    await startImport(page, TRANSCRIPT);
    await expect(page.getByRole('heading', { level: 1, name: 'Fake AI Soup' })).toBeVisible();
    await expect(sourceBanner(page)).toContainText('From the video transcript - check quantities');
    await expect(page.getByLabel('Paste the transcript')).toHaveCount(0);
  });

  test('no captions asks for the transcript; pasting it previews and saves', async ({ page, api }) => {
    await startImport(page, NO_CAPTIONS);
    await expect(page.getByRole('status').filter({ hasText: "Couldn't get the transcript automatically" })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.getByLabel('Paste the transcript').fill(TRANSCRIPT_TEXT);
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Fake AI Soup' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'AI-assisted - check the ingredients' })).toBeVisible();
    await page.locator('button.save').first().click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const recipes = await api.recipes();
    expect(recipes.map((r) => r.title)).toEqual(['Fake AI Soup']);
    expect((await api.recipe(recipes[0].id)).sourceUrl).toBe(NO_CAPTIONS);
  });

  test('a vlog shows the not-a-recipe panel; Import anyway previews a best-effort AI draft that saves', async ({ page, api }) => {
    await startImport(page, VLOG);
    const panel = page.locator('.not-recipe');
    await expect(panel).toContainText("That doesn't look like a recipe");
    await expect(panel).toContainText('Fake: this is a travel vlog');

    // forceRecipe makes the server's one LLM call a best-effort one (no isRecipe exit), so a draft comes back.
    await panel.getByRole('button', { name: 'Import anyway' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Fake AI Soup' })).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(page.getByLabel('Paste the transcript')).toHaveCount(0);
    await expect(sourceBanner(page)).toContainText('From the video transcript - check quantities');

    await page.locator('button.save').first().click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const recipes = await api.recipes();
    expect(recipes.map((r) => r.title)).toEqual(['Fake AI Soup']);
    expect((await api.recipe(recipes[0].id)).sourceUrl).toBe(VLOG);
  });
});

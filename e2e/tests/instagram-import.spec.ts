import { expect, test } from '../fixtures/api';

// Needs the stack's dev-only hooks: NABBIT_E2E_FAKE_LLM=1 (backend/src/local.ts) swaps the LLM parser for a
// deterministic stub that answers only for text containing [[fake-llm]]. The stack also lists
// ig.nabbit-fixtures.test as an Instagram host (NABBIT_E2E_INSTAGRAM_HOSTS, dev server only), so the real auto-fetch
// path runs against fixtures served from the fixture site; e2e never fetches the real instagram.com.
// instagram-login.html is the login wall (needs_text -> paste fallback); instagram-post.html is a fetchable post.
const IG_URL = 'https://ig.nabbit-fixtures.test/instagram-login.html';
const IG_POST_URL = 'https://ig.nabbit-fixtures.test/instagram-post.html';
const CAPTION = 'omg this soup!! so good [[fake-llm]] stock onion carrots simmer';

async function importViaPaste(page: import('@playwright/test').Page) {
  await page.goto('/import');
  await page.getByLabel('Paste a link or recipe text').fill(IG_URL);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: "Instagram wouldn't let us read this post" })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Paste the caption').fill(CAPTION);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('note').filter({ hasText: 'AI-assisted - check the ingredients' })).toBeVisible();
  await expect(page.locator('input.title')).toHaveValue('Fake AI Soup');
}

test.describe('journey 11: Instagram paste and AI-assisted import', () => {
  test('auto-fetch: the post URL imports directly, no paste prompt, and saves with the post sourceUrl', async ({ page, api }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill(IG_POST_URL);
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.locator('input.title')).toHaveValue('Garlic Butter Beans on Toast');
    await expect(page.getByLabel('Paste the caption')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: "Instagram wouldn't let us read this post" })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.ingredient .preview summary')).toHaveCount(4);
    await expect(page.getByText('Recipe in a comment?')).toBeVisible();

    await page.locator('button.save').click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const recipes = await api.recipes();
    expect(recipes.map((r) => r.title)).toEqual(['Garlic Butter Beans on Toast']);
    expect((await api.recipe(recipes[0].id)).sourceUrl).toBe(IG_POST_URL);
  });

  test('login-wall Instagram URL asks for the caption, the AI draft is flagged, and it saves with the Instagram source', async ({ page, api }) => {
    await importViaPaste(page);
    await page.locator('button.save').click();

    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Fake AI Soup' })).toBeVisible();
    const recipes = await api.recipes();
    expect(recipes.map((r) => r.title)).toEqual(['Fake AI Soup']);
    expect((await api.recipe(recipes[0].id)).sourceUrl).toBe(IG_URL);
  });

  test('"Recipe in a comment?" re-imports caption + comment and replaces the draft, steps included', async ({ page }) => {
    await importViaPaste(page);
    const rows = page.locator('.ingredient .preview summary');
    await expect(rows).toHaveCount(3);

    await page.getByText('Recipe in a comment?').click();
    await page.getByLabel('Paste the comment').fill('Ingredients\n1 cup rice\n2 eggs\n3 carrots\n\nMethod\n1. Cook the rice.\n2. Stir in the eggs.');
    await page.getByRole('button', { name: 'Add and re-import' }).click();

    await expect(rows).toHaveCount(3);
    await expect(page.locator('textarea.step').first()).toHaveValue('Cook the rice.');
    await expect(page.locator('textarea.step')).toHaveCount(2);
  });

  test('the comment appender is disabled once the user has edited the preview, so edits survive', async ({ page }) => {
    await importViaPaste(page);
    await page.getByText('Recipe in a comment?').click();
    await page.getByLabel('Paste the comment').fill('1 cup rice');
    await expect(page.getByRole('button', { name: 'Add and re-import' })).toBeEnabled();
    await page.locator('input.title').fill('My own soup title');
    await expect(page.getByRole('button', { name: 'Add and re-import' })).toBeDisabled();
    await expect(page.locator('input.title')).toHaveValue('My own soup title');
  });

  test('a normal structured page is unaffected: no AI banner', async ({ page }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill('https://nabbit-fixtures.test/pasta.html');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.locator('input.title')).toHaveValue('Lemon Pasta');
    await expect(page.getByRole('note').filter({ hasText: 'AI-assisted' })).toHaveCount(0);
  });
});

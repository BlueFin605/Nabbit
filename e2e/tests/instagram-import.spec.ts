import { expect, test } from '../fixtures/api';

// Needs the stack's dev-only hooks: NABBIT_E2E_FAKE_LLM=1 (backend/src/local.ts) swaps the LLM parser for a
// deterministic stub that answers only for text containing [[fake-llm]]. The stack also lists
// ig.nabbit-fixtures.test as an Instagram host (NABBIT_E2E_INSTAGRAM_HOSTS, dev server only), so the real auto-fetch
// path runs against fixtures served from the fixture site; e2e never fetches the real instagram.com.
// instagram-login.html is the login wall (needs_text -> paste fallback); instagram-post.html is a fetchable post.
const IG_URL = 'https://ig.nabbit-fixtures.test/instagram-login.html';
const IG_POST_URL = 'https://ig.nabbit-fixtures.test/instagram-post.html';
const IG_COMMENTS_URL = 'https://ig.nabbit-fixtures.test/instagram-comments.html'; // caption says "recipe in the comments"
const CAPTION ='omg this soup!! so good [[fake-llm]] stock onion carrots simmer';

async function importViaPaste(page: import('@playwright/test').Page) {
  await page.goto('/import');
  await page.getByLabel('Paste a link or recipe text').fill(IG_URL);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: "Instagram wouldn't let us read this post" })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Paste the caption').fill(CAPTION);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('note').filter({ hasText: 'AI-assisted - check the ingredients' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Fake AI Soup' })).toBeVisible();
}

test.describe('journey 11: Instagram paste and AI-assisted import', () => {
  test('auto-fetch: the post URL imports directly, no paste prompt, and saves with the post sourceUrl', async ({ page, api }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill(IG_POST_URL);
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Garlic Butter Beans on Toast' })).toBeVisible();
    await expect(page.getByLabel('Paste the caption')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: "Instagram wouldn't let us read this post" })).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('ul.ingredients li')).toHaveCount(4);
    await expect(page.getByText('Recipe in a comment?')).toBeVisible();

    await page.locator('button.save').first().click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const recipes = await api.recipes();
    expect(recipes.map((r) => r.title)).toEqual(['Garlic Butter Beans on Toast']);
    expect((await api.recipe(recipes[0].id)).sourceUrl).toBe(IG_POST_URL);
  });

  test('login-wall Instagram URL asks for the caption, the AI draft is flagged, and it saves with the Instagram source', async ({ page, api }) => {
    await importViaPaste(page);
    await page.locator('button.save').first().click();

    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Fake AI Soup' })).toBeVisible();
    const recipes = await api.recipes();
    expect(recipes.map((r) => r.title)).toEqual(['Fake AI Soup']);
    expect((await api.recipe(recipes[0].id)).sourceUrl).toBe(IG_URL);
  });

  test('"Recipe in a comment?" re-imports caption + comment and replaces the draft, steps included', async ({ page }) => {
    await importViaPaste(page);
    const rows = page.locator('ul.ingredients li');
    await expect(rows).toHaveCount(3);

    await page.getByText('Recipe in a comment?').click();
    await page.getByLabel('Paste the comment').fill('Ingredients\n1 cup rice\n2 eggs\n3 carrots\n\nMethod\n1. Cook the rice.\n2. Stir in the eggs.');
    await page.getByRole('button', { name: 'Add and re-import' }).click();

    await expect(rows).toHaveCount(3);
    await expect(page.locator('ol.steps li').first()).toContainText('Cook the rice.');
    await expect(page.locator('ol.steps li')).toHaveCount(2);
  });

  test('the comment appender is disabled once the user has edited the preview, so edits survive', async ({ page }) => {
    await importViaPaste(page);
    await page.getByText('Recipe in a comment?').click();
    await page.getByLabel('Paste the comment').fill('1 cup rice');
    await expect(page.getByRole('button', { name: 'Add and re-import' })).toBeEnabled();
    // Edit in the editor and come back: the carried-back edit disables the appender and shows in the preview.
    await page.locator('button.toggle-edit').first().click();
    await page.locator('input.title').fill('My own soup title');
    await page.locator('button.toggle-edit').first().click();
    await expect(page.getByRole('button', { name: 'Add and re-import' })).toBeDisabled();
    await expect(page.getByRole('heading', { level: 1, name: 'My own soup title' })).toBeVisible();
  });

  test('"recipe in the comments" post: no not-a-recipe panel, the photo is kept and the pasted comment is added', async ({ page, api }) => {
    // The caption gets a NotRecipe verdict from the fake LLM; on Instagram that keeps the (empty) heuristic draft and the
    // post photo instead of a 422, so the comment appender can recover the recipe.
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill(IG_COMMENTS_URL);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText('Recipe in a comment?')).toBeVisible();
    await expect(page.locator('.not-recipe')).toHaveCount(0);
    await expect(page.getByText('Photo found, will be saved')).toBeVisible();

    // The comment also reads as not-a-recipe to the fake LLM, but the appender sends forceRecipe (the user said it is one).
    await page.getByText('Recipe in a comment?').click();
    await page.getByLabel('Paste the comment').fill('[[fake-not-recipe]] here it is: stock, onion, carrots');
    await page.getByRole('button', { name: 'Add and re-import' }).click();
    await expect(page.locator('ol.steps li').filter({ hasText: 'Simmer everything in the stock.' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Photo found, will be saved')).toBeVisible();

    await page.locator('button.save').first().click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const [saved] = await api.recipes();
    expect(saved.imageKey).toMatch(/^local-dev-user-id\//);
    expect(saved.sourceUrl).toBe(IG_COMMENTS_URL);
  });

  test('a normal structured page is unaffected: no AI banner', async ({ page }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill('https://nabbit-fixtures.test/pasta.html');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Lemon Pasta' })).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'AI-assisted' })).toHaveCount(0);
  });
});

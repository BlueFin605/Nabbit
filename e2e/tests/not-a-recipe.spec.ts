import { expect, test } from '../fixtures/api';

// Needs the stack's dev-only fake LLM (NABBIT_E2E_FAKE_LLM=1, backend/src/local.ts): pasted text containing
// [[fake-not-recipe]] gets a NotRecipe verdict with the reason below, so the route answers 422 not_a_recipe;
// a forced ("Import anyway") call gets the fake's soup recipe instead.
const TEXT = 'Our week in Lisbon, so much walking [[fake-not-recipe]] trams and tiles';

test.describe('not-a-recipe guardrail', () => {
  test('shows the reason and "Import anyway" previews a best-effort AI draft', async ({ page }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill(TEXT);
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    const panel = page.getByRole('alert').filter({ hasText: "doesn't look like a recipe" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Fake: this is a travel vlog');

    // forceRecipe makes the one LLM call a best-effort one (no isRecipe exit); the fake answers it with its soup.
    await page.getByRole('button', { name: 'Import anyway' }).click();
    await expect(page.locator('app-recipe-view h1')).toHaveText('Fake AI Soup');
    await expect(page.locator('app-import-action-bar.top')).toBeVisible();
    await expect(page.locator('ul.ingredients li')).toHaveCount(3);
    await expect(page.getByRole('note').filter({ hasText: 'AI-assisted - check the ingredients' })).toBeVisible();
    await expect(page.locator('input.title')).toHaveCount(0);
    await expect(page.getByText("doesn't look like a recipe")).toHaveCount(0);
  });

  test('"Paste text instead" hides the panel and keeps the text for editing', async ({ page }) => {
    await page.goto('/import');
    const box = page.getByLabel('Paste a link or recipe text');
    await box.fill(TEXT);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: "doesn't look like a recipe" })).toBeVisible();

    await page.getByRole('button', { name: 'Paste text instead' }).click();
    await expect(page.getByText("doesn't look like a recipe")).toHaveCount(0);
    await expect(page.locator('input.title')).toHaveCount(0);
    await expect(page.locator('textarea')).toHaveValue(TEXT);
  });
});

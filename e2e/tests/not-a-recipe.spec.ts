import { expect, test } from '../fixtures/api';

// Needs the stack's dev-only fake LLM (NABBIT_E2E_FAKE_LLM=1, backend/src/local.ts): pasted text containing
// [[fake-not-recipe]] gets a NotRecipe verdict with the reason below, so the route answers 422 not_a_recipe.
const TEXT = 'Our week in Lisbon, so much walking [[fake-not-recipe]] trams and tiles';

test.describe('not-a-recipe guardrail', () => {
  test('shows the reason and "Import anyway" falls back to the heuristic draft', async ({ page }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill(TEXT);
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    const panel = page.getByRole('alert').filter({ hasText: "doesn't look like a recipe" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Fake: this is a travel vlog');

    await page.getByRole('button', { name: 'Import anyway' }).click();
    await expect(page.locator('input.title')).toBeVisible();
    await expect(page.getByText("doesn't look like a recipe")).toHaveCount(0);
    await expect(page.getByRole('note').filter({ hasText: 'AI-assisted' })).toHaveCount(0);
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

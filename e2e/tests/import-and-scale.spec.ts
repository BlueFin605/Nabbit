import { expect, test, PANCAKES } from '../fixtures/api';

test.describe('journey 1: paste import', () => {
  test('empty state -> paste text -> metric preview with heuristic banner -> save -> recipe view', async ({ page, api }) => {
    // The e2e frontend build runs with auth disabled (a fixed dev user), so there is no sign-in screen:
    // landing on /recipes must not bounce to /signin.
    await page.goto('/recipes');
    await expect(page).toHaveURL(/\/recipes$/);
    await expect(page.getByText('No recipes yet — tap + to add one')).toBeVisible();

    await page.getByRole('button', { name: 'Add recipe' }).click();
    await expect(page).toHaveURL(/\/import$/);
    await page.getByLabel('Paste a link or recipe text').fill(PANCAKES);
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByRole('note').filter({ hasText: 'Check this one carefully' })).toBeVisible();
    await expect(page.locator('input.title')).toHaveValue('Fluffy Pancakes');
    await expect(page.locator('.ingredient .preview summary').first()).toHaveText('480 ml all-purpose flour');

    await page.locator('button.save').click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Fluffy Pancakes' })).toBeVisible();
    await expect(page.locator('ul.ingredients li').first()).toContainText('480 ml all-purpose flour');
    expect(await api.recipes()).toHaveLength(1);
  });
});

test.describe('journey 2: scaling is not persisted until "Save as new size"', () => {
  test('4 -> 6 servings scales, reload reverts, Save as new size persists', async ({ page, api }) => {
    const recipe = await api.seedRecipe();
    await page.goto(`/recipes/${recipe.id}`);
    const servings = page.locator('.stepper output');
    const flour = page.locator('ul.ingredients li').first();
    await expect(servings).toHaveText('4');
    await expect(flour).toContainText('480 ml all-purpose flour');
    await expect(page.locator('button.save-size')).toHaveCount(0);

    await page.getByRole('button', { name: 'More servings' }).click();
    await page.getByRole('button', { name: 'More servings' }).click();
    await expect(servings).toHaveText('6');
    await expect(flour).toContainText('720 ml all-purpose flour');

    // Not persisted: a reload shows the stored values again.
    await page.reload();
    await expect(servings).toHaveText('4');
    await expect(flour).toContainText('480 ml all-purpose flour');
    expect((await api.recipe(recipe.id)).servings).toBe(4);

    // Persist it.
    await page.getByRole('button', { name: 'More servings' }).click();
    await page.getByRole('button', { name: 'More servings' }).click();
    await page.getByRole('button', { name: 'Save as new size (6 servings)' }).click();
    await page.getByRole('button', { name: 'Save new size' }).click();
    await expect(page.locator('button.save-size')).toHaveCount(0);
    await expect(servings).toHaveText('6');

    await page.reload();
    await expect(servings).toHaveText('6');
    await expect(flour).toContainText('720 ml all-purpose flour');
    expect((await api.recipe(recipe.id)).servings).toBe(6);
  });
});

test.describe('journey 3: edit an ingredient, and version conflicts', () => {
  test('quantity edit updates the metric text, persists, and a stale editor gets the conflict prompt', async ({ page, browser, api }) => {
    const recipe = await api.seedRecipe();
    const preview = (p: typeof page) => p.locator('.ingredient').first().locator('.preview summary');

    await page.goto(`/recipes/${recipe.id}/edit`);
    await expect(preview(page)).toHaveText('480 ml all-purpose flour');

    // A second browser context opens the same (soon stale) version.
    const other = await browser.newContext({ ...test.info().project.use });
    const stale = await other.newPage();
    await stale.goto(`/recipes/${recipe.id}/edit`);
    await expect(preview(stale)).toHaveText('480 ml all-purpose flour');

    await page.locator('.ingredient').first().locator('input.qty').fill('3');
    await expect(preview(page)).toHaveText('720 ml all-purpose flour');
    await page.locator('button.save').click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${recipe.id}$`));
    await page.reload();
    await expect(page.locator('ul.ingredients li').first()).toContainText('720 ml all-purpose flour');

    // The stale editor saves its own change -> 409 -> conflict prompt; Reload picks up the newer version.
    await stale.locator('.ingredient').first().locator('input.qty').fill('5');
    await stale.locator('button.save').click();
    const conflict = stale.getByRole('alert').filter({ hasText: 'This recipe changed on another device' });
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: 'Reload' }).click();
    await expect(preview(stale)).toHaveText('720 ml all-purpose flour');
    expect((await api.recipe(recipe.id)).version).toBe(recipe.version + 1);
    await other.close();
  });
});

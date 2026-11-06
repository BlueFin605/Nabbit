import { expect, test } from '../fixtures/api';

test.describe('journey 8: delete a recipe', () => {
  test('from the list: confirm, card disappears, Undo brings it back', async ({ page, api }) => {
    await api.seedRecipe('Fluffy Pancakes');
    await api.seedRecipe('Second Dish');
    await page.goto('/recipes');
    await expect(page.locator('.card')).toHaveCount(2);

    await page.getByRole('button', { name: 'Delete recipe Second Dish' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Second Dish' })).toHaveCount(0);
    await expect(page.locator('.card')).toHaveCount(1);
    expect((await api.recipes()).map((r) => r.title)).toEqual(['Fluffy Pancakes']);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('heading', { name: 'Second Dish' })).toBeVisible();
    await expect(page.locator('.card')).toHaveCount(2);
    expect(await api.recipes()).toHaveLength(2);
  });

  test('from the detail page: lands on /recipes, Undo restores', async ({ page, api }) => {
    const keep = await api.seedRecipe('Fluffy Pancakes');
    const gone = await api.seedRecipe('Second Dish');
    await page.goto(`/recipes/${gone.id}`);
    await page.getByRole('button', { name: 'Delete', exact: true }).click(); // the detail page's delete action
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page).toHaveURL(/\/recipes$/);
    await expect(page.locator('.card')).toHaveCount(1);
    expect((await api.recipes()).map((r) => r.id)).toEqual([keep.id]);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${gone.id}$`));
    expect(await api.recipes()).toHaveLength(2);
  });
});

test.describe('journey 9: recipe list views', () => {
  test('the chosen view persists across a reload and delete is visible in each', async ({ page, api }) => {
    await api.seedRecipe('Fluffy Pancakes');
    await api.seedRecipe('Second Dish');
    await page.goto('/recipes');
    const del = page.locator('.card-delete');
    const grid = page.locator('.grid');

    await expect(grid).toHaveClass(/view-large/);
    await expect(del).toHaveCount(2);
    await expect(del.first()).toBeVisible();

    await page.locator('mat-button-toggle[value="small"] button').click();
    await expect(grid).toHaveClass(/view-small/);
    await expect(del.first()).toBeVisible();
    await expect(del.last()).toBeVisible();

    await page.locator('mat-button-toggle[value="list"] button').click();
    await expect(grid).toHaveClass(/view-list/);
    await expect(del.first()).toBeVisible();
    await expect(del.last()).toBeVisible();

    await page.reload();
    await expect(page.locator('.grid')).toHaveClass(/view-list/);
    await expect(page.locator('mat-button-toggle[value="list"]')).toHaveClass(/mat-button-toggle-checked/);
    await expect(del.first()).toBeVisible();

    await page.locator('mat-button-toggle[value="small"] button').click();
    await page.reload();
    await expect(page.locator('.grid')).toHaveClass(/view-small/);
  });
});

test.describe('journey 10: one-tap add', () => {
  test('adds a single ingredient to the list with a snackbar, and Undo removes it', async ({ page, api }) => {
    const r = await api.seedRecipe();
    await page.goto(`/recipes/${r.id}`);
    await page.getByRole('button', { name: 'Add butter to shopping list' }).click();
    await expect(page.getByText('Added to Shopping')).toBeVisible();

    // Undo is exercised after verifying the item landed on the list.
    await page.goto('/lists');
    const item = page.getByText('butter (200 g)');
    await expect(item).toBeVisible();

    await page.goto(`/recipes/${r.id}`);
    await page.getByRole('button', { name: 'Add eggs to shopping list' }).click();
    await expect(page.getByText('Added to Shopping')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.goto('/lists');
    await expect(page.getByText('butter (200 g)')).toBeVisible();
    await expect(page.getByText('eggs (2)')).toHaveCount(0);
  });
});

import { expect, test, seedIngredient } from '../fixtures/api';
import type { Page } from '@playwright/test';

const MOZZARELLA = {
  title: 'Mozzarella',
  servings: 4,
  tags: [],
  steps: ['Warm the milk.', 'Add the rennet.'],
  ingredients: [
    seedIngredient('i-milk', 'milk', 4, 'l'),
    seedIngredient('i-rennet', 'rennet', 1, 'ml'),
    seedIngredient('i-salt', 'salt to taste', null, ''),
  ],
};

const line = (page: Page, text: string) => page.locator('ul.ingredients li').filter({ hasText: text });
const amount = (page: Page) => page.locator('input.anchor-amount');

test.describe('scale by ingredient: the mozzarella case', () => {
  test('default on milk, scale to 6 l, Reset, Save as new size, edit, Restore original size', async ({ page, api }) => {
    const seeded = await api.seedCustom(MOZZARELLA);
    expect(seeded.scaleBy).toBeUndefined();

    // Editor: choose milk as the default scale-by and save.
    await page.goto(`/recipes/${seeded.id}/edit`);
    await page.getByRole('radio', { name: 'Default scale-by: milk' }).check();
    await expect(page.getByRole('radio', { name: 'Default scale-by: milk' })).toBeChecked();
    // Salt (no quantity) is not an anchor, so it has no radio.
    await expect(page.getByRole('radio', { name: 'Default scale-by: salt to taste' })).toHaveCount(0);
    await page.locator('button.save').click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${seeded.id}$`));
    const stored = await api.recipe(seeded.id);
    expect(stored.scaleBy).toBe('i-milk');
    expect(stored.originalSize).toBeUndefined();

    // View opens in ingredient mode on milk, preset to 4 l.
    const select = page.locator('select.scale-by');
    await expect(select).toHaveValue('i-milk');
    await expect(amount(page)).toHaveValue('4');
    await expect(page.locator('select.anchor-unit')).toHaveValue('l');
    await expect(page.locator('.scale-summary .factor')).toHaveText('×1');
    await expect(page.locator('button.save-size')).toHaveCount(0);
    // Selector offers Servings + milk + rennet, but not salt.
    expect(await select.locator('option').allTextContents()).toEqual(['Servings', 'milk', 'rennet']);

    // 6 l: rennet 1.5 ml, about 6 servings, x1.5; salt unscaled.
    await amount(page).fill('6');
    await expect(page.locator('.scale-summary .factor')).toHaveText('×1.5');
    await expect(page.locator('.derived-servings')).toHaveText('≈ 6 servings');
    await expect(line(page, 'rennet')).toContainText('1.5 ml');
    await expect(line(page, 'milk')).toContainText('6 l');
    await expect(line(page, 'salt to taste')).toContainText('salt to taste');
    expect((await api.recipe(seeded.id)).servings).toBe(4); // not persisted

    // Reset returns to 4 l.
    await page.locator('button.reset-scale').click();
    await expect(amount(page)).toHaveValue('4');
    await expect(line(page, 'rennet')).toContainText('1 ml');
    await expect(page.locator('button.reset-scale')).toHaveCount(0);

    // Scale again and save as a new size.
    await amount(page).fill('6');
    await page.getByRole('button', { name: 'Save as new size (6 servings)' }).click();
    await page.getByRole('button', { name: 'Save new size' }).click();
    await expect(page.locator('button.restore-original')).toBeVisible();
    await expect(page.locator('button.save-size')).toHaveCount(0);

    const saved = await api.recipe(seeded.id);
    expect(saved.servings).toBe(6);
    expect(saved.ingredients.find((i) => i.id === 'i-milk')?.quantity).toBe(6);
    expect(saved.ingredients.find((i) => i.id === 'i-rennet')?.quantity).toBe(1.5);
    expect(saved.scaleBy).toBe('i-milk');
    expect(saved.originalSize?.servings).toBe(4);
    expect(saved.originalSize?.ingredients.find((i) => i.id === 'i-milk')?.quantity).toBe(4);

    // Edit rennet's name in the editor, return, and restore.
    await page.getByRole('link', { name: 'Edit' }).click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${seeded.id}/edit$`));
    await expect(page.locator('.ingredient')).toHaveCount(3);
    await page.locator('input.name').nth(1).fill('liquid rennet');
    await page.locator('button.save').click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${seeded.id}$`));
    expect((await api.recipe(seeded.id)).originalSize?.servings).toBe(4); // kept by the editor

    await page.locator('button.restore-original').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('.warning')).toContainText('any changes made since the first resize will be lost');
    await expect(dialog.locator('.servings')).toHaveText('Servings: 6 → 4');
    await expect(dialog.locator('li.changed')).toHaveCount(2); // milk quantity, rennet name and quantity
    await expect(dialog.locator('li.changed').filter({ hasText: 'liquid rennet' })).toHaveCount(1);
    await dialog.locator('button.confirm').click();
    await expect(page.locator('button.restore-original')).toHaveCount(0);

    const restored = await api.recipe(seeded.id);
    expect(restored.servings).toBe(4);
    expect(restored.ingredients.find((i) => i.id === 'i-milk')?.quantity).toBe(4);
    expect(restored.ingredients.find((i) => i.id === 'i-rennet')).toMatchObject({ name: 'rennet', quantity: 1 });
    expect(restored.originalSize).toBeUndefined();
    await expect(line(page, 'milk')).toContainText('4 l');
  });

  test('a tiny target is out of range: "under 1 serving" and Save as new size is disabled with the explanation', async ({ page, api }) => {
    const seeded = await api.seedCustom({ ...MOZZARELLA, scaleBy: 'i-milk' });
    await page.goto(`/recipes/${seeded.id}`);
    await expect(amount(page)).toHaveValue('4');
    await amount(page).fill('0.1');
    await expect(page.locator('.derived-servings')).toHaveText('under 1 serving');
    await expect(page.getByRole('button', { name: /Save as new size \(under 1 serving\)/ })).toBeDisabled();
    await expect(page.locator('#size-bounds')).toHaveText('Resulting servings must be between 1 and 99.');
    expect((await api.recipe(seeded.id)).servings).toBe(4);
  });

  test('Servings mode on a recipe without a default still scales as before', async ({ page, api }) => {
    const r = await api.seedRecipe('Fluffy Pancakes');
    await page.goto(`/recipes/${r.id}`);
    await expect(page.locator('select.scale-by')).toHaveValue('servings');
    await expect(page.locator('input.anchor-amount')).toHaveCount(0);
    const servings = page.locator('.stepper output');
    await expect(servings).toHaveText('4');
    await page.getByRole('button', { name: 'More servings' }).click();
    await page.getByRole('button', { name: 'More servings' }).click();
    await expect(servings).toHaveText('6');
    await expect(page.locator('ul.ingredients li').first()).toContainText('720 ml all-purpose flour');
    await expect(line(page, 'butter')).toContainText('300 g');
    await expect(line(page, 'salt to taste')).toContainText('salt to taste');
    await page.getByRole('button', { name: 'Save as new size (6 servings)' }).click();
    await page.getByRole('button', { name: 'Save new size' }).click();
    await expect(page.locator('button.restore-original')).toBeVisible();
    const saved = await api.recipe(r.id);
    expect(saved.servings).toBe(6);
    expect(saved.scaleBy).toBeUndefined();
    expect(saved.originalSize?.servings).toBe(4);
  });

  test('360px viewport: scale-by controls cause no horizontal overflow', async ({ page, api }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const seeded = await api.seedCustom({ ...MOZZARELLA, scaleBy: 'i-milk' });
    await page.goto(`/recipes/${seeded.id}`);
    await amount(page).fill('6');
    await expect(page.locator('button.reset-scale')).toBeVisible();
    await expect(page.locator('button.save-size')).toBeVisible();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    for (const sel of ['select.scale-by', 'input.anchor-amount', 'select.anchor-unit', 'button.save-size']) {
      const box = await page.locator(sel).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    }

    await page.goto(`/recipes/${seeded.id}/edit`);
    await expect(page.getByRole('radio', { name: 'Default scale-by: milk' })).toBeChecked();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});

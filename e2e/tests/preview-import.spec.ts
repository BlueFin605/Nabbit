import { expect, test } from '../fixtures/api';
import type { Page } from '@playwright/test';

// The import page opens in a read-only preview; Edit switches to the editor on the same draft, and the action bar
// (Save / Edit / Discard) is rendered twice: a sticky one at the top (.top) and one at the bottom.
const PASTA_URL = 'https://nabbit-fixtures.test/pasta.html';

async function importUrl(page: Page, url: string) {
  await page.goto('/import');
  await page.getByLabel('Paste a link or recipe text').fill(url);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** A pasted recipe long enough that the page scrolls well past the viewport. */
const LONG_RECIPE = [
  'Very Long Stew',
  'Serves 6',
  '',
  'Ingredients',
  ...Array.from({ length: 12 }, (_, i) => `${i + 1} cup vegetable number ${i + 1}`),
  '',
  'Method',
  ...Array.from({ length: 30 }, (_, i) => `${i + 1}. Stir the pot for step number ${i + 1} and keep it gentle.`),
].join('\n');

test.describe('import preview and action bar', () => {
  test('an import opens in the read-only preview, not the editor', async ({ page }) => {
    await importUrl(page, PASTA_URL);
    await expect(page.getByRole('heading', { level: 1, name: 'Lemon Pasta' })).toBeVisible();
    await expect(page.locator('input.title')).toHaveCount(0);
    await expect(page.locator('textarea.step')).toHaveCount(0);
    await expect(page.locator('ul.ingredients li')).toHaveCount(3);
    // The bar is rendered twice, with Edit offered (not "Back to preview").
    await expect(page.locator('button.save')).toHaveCount(2);
    await expect(page.locator('button.toggle-edit')).toHaveText(['Edit', 'Edit']);
  });

  test('Edit, change the title, Back to preview: the new title shows in the preview', async ({ page, api }) => {
    await importUrl(page, PASTA_URL);
    await page.locator('button.toggle-edit').first().click();
    await expect(page.locator('input.title')).toHaveValue('Lemon Pasta');
    await expect(page.locator('button.toggle-edit').first()).toHaveText('Back to preview');
    await page.locator('input.title').fill('Lemon Pasta, My Way');

    await page.locator('button.toggle-edit').first().click();
    await expect(page.locator('input.title')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Lemon Pasta, My Way' })).toBeVisible();
    expect(await api.recipes()).toHaveLength(0);

    // The edit is what gets saved.
    await page.locator('button.save').first().click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    expect((await api.recipes()).map((r) => r.title)).toEqual(['Lemon Pasta, My Way']);
  });

  test('Save from the TOP bar saves the recipe', async ({ page, api }) => {
    await importUrl(page, PASTA_URL);
    await page.locator('app-import-action-bar.top button.save').click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    expect((await api.recipes()).map((r) => r.title)).toEqual(['Lemon Pasta']);
  });

  test('Save from the BOTTOM bar saves the recipe', async ({ page, api }) => {
    await importUrl(page, PASTA_URL);
    await page.locator('app-import-action-bar:not(.top) button.save').click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    expect((await api.recipes()).map((r) => r.title)).toEqual(['Lemon Pasta']);
  });

  test('Save works from the bottom bar while editing too', async ({ page, api }) => {
    await importUrl(page, PASTA_URL);
    await page.locator('button.toggle-edit').first().click();
    await page.locator('input.title').fill('Edited then saved below');
    await page.locator('app-import-action-bar:not(.top) button.save').click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    expect((await api.recipes()).map((r) => r.title)).toEqual(['Edited then saved below']);
  });

  test('Discard without edits leaves straight away; after an edit it confirms, and confirming saves nothing', async ({ page, api }) => {
    await importUrl(page, PASTA_URL);
    await page.locator('button.discard').first().click();
    await expect(page).toHaveURL(/\/recipes$/);

    await importUrl(page, PASTA_URL);
    await page.locator('button.toggle-edit').first().click();
    await page.locator('input.title').fill('Throwaway title');
    await page.locator('app-import-action-bar:not(.top) button.discard').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Discard this recipe?');
    // Keep editing leaves the draft and the page alone.
    await dialog.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/import/);
    await expect(page.locator('input.title')).toHaveValue('Throwaway title');

    await page.locator('button.discard').first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page).toHaveURL(/\/recipes$/);
    expect(await api.recipes()).toHaveLength(0);
  });

  test('the top action bar stays stuck to the top of the viewport when the page is scrolled to the bottom', async ({ page }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill(LONG_RECIPE);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Very Long Stew' })).toBeVisible();

    const top = page.locator('app-import-action-bar.top');
    const topSave = top.locator('button.save');
    const viewport = page.viewportSize()!;

    // Scroll whatever scrolls (the window or a scroll container) as far as it goes.
    const scrolled = await page.evaluate(() => {
      const els = [document.scrollingElement, ...Array.from(document.querySelectorAll<HTMLElement>('*'))].filter(
        (e): e is HTMLElement => !!e && e.scrollHeight > e.clientHeight + 1 && (e === document.scrollingElement || /auto|scroll/.test(getComputedStyle(e).overflowY)),
      );
      let max = 0;
      for (const e of els) {
        e.scrollTop = e.scrollHeight;
        max = Math.max(max, e.scrollTop);
      }
      return max;
    });
    expect(scrolled, 'the long recipe must actually scroll').toBeGreaterThan(viewport.height / 2);

    // The bottom bar is reachable and the top bar is still on screen, pinned at the top.
    await expect(page.locator('app-import-action-bar:not(.top) button.save')).toBeInViewport();
    await expect(topSave).toBeInViewport();
    const box = await top.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    // It is the sticky bar that is pinned, not the page header: the bar sits within the first 100px.
    expect(box!.y).toBeLessThan(100);
    // And it is the element hit at its own centre (nothing overlaps it).
    const hit = await topSave.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    expect(hit).toBe(true);
  });

});

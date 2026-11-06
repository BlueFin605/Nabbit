import { expect, test } from '../fixtures/api';

test.describe('journey 4: add to list, check, delete, undo', () => {
  test('unticked ingredient is skipped; tap checks and moves down; double-tap deletes; Undo restores', async ({ page, api }) => {
    const recipe = await api.seedRecipe();
    await page.goto(`/recipes/${recipe.id}`);
    await page.getByRole('button', { name: 'Add to list' }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Add to list')).toBeVisible();
    // "salt to taste" starts unticked; untick eggs too -> flour, milk, butter remain.
    await dialog.getByRole('checkbox', { name: '2 eggs' }).uncheck();
    await expect(dialog.getByRole('button', { name: 'Add 3 items' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Add 3 items' }).click();

    await page.getByRole('button', { name: 'View list' }).click();
    await expect(page).toHaveURL(/\/lists$/);

    const items = page.locator('button.item');
    await expect(items).toHaveCount(3);
    await expect(page.locator('.aisle-group')).not.toHaveCount(0);
    await expect(page.locator('button.item .label')).toContainText([
      'all-purpose flour (480 ml)',
      'milk (240 ml)',
      'butter (200 g)',
    ]);
    await expect(page.getByText('eggs')).toHaveCount(0);

    // Tap flour: checked, struck through, and moved below the unchecked items of its aisle.
    const flour = page.locator('button.item', { hasText: 'all-purpose flour' });
    await flour.click();
    await expect(flour).toHaveAttribute('aria-checked', 'true');
    await expect(flour.locator('.box')).toHaveText('✓');
    const order = await page.locator('.aisle-group').evaluateAll((groups) =>
      groups.map((g) => [...g.querySelectorAll('button.item .label')].map((l) => l.textContent?.trim() ?? '')),
    );
    const flat = order.find((g) => g.some((n) => n.startsWith('all-purpose flour')))!;
    expect(flat[flat.length - 1]).toContain('all-purpose flour');

    // Double-tap milk (two taps inside 300 ms) deletes it; Undo puts it back.
    await page.waitForTimeout(400); // clear the double-tap window of the flour tap
    await page.locator('button.item', { hasText: 'milk' }).dblclick();
    await expect(page.locator('button.item', { hasText: 'milk' })).toHaveCount(0);
    await expect(items).toHaveCount(2);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('button.item', { hasText: 'milk (240 ml)' })).toBeVisible();
    await expect(items).toHaveCount(3);
  });
});

test.describe('journey 5: installability', () => {
  test('serves a manifest with a GET /import share_target and fetchable icons', async ({ page, request }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();
    const url = new URL(href!, page.url()).href;

    const res = await request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/manifest\+json|application\/json/);
    const manifest = await res.json();
    expect(manifest).toMatchObject({
      name: 'Nabbit',
      display: 'standalone',
      start_url: '/recipes',
      share_target: { action: '/import', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
    });
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of manifest.icons as { src: string; type: string }[]) {
      const r = await request.get(new URL(icon.src, url).href);
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()['content-type']).toBe(icon.type);
    }
  });
});

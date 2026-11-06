import { expect, test } from '../fixtures/api';

// Needs the stack's fixture hook: the backend runs with NABBIT_E2E_FIXTURE_FETCH=1 so the importer's
// resolver/transport serve https://nabbit-fixtures.test/* from e2e/fixtures/site (backend/src/e2e-fixture-fetch.ts).
// The SSRF guard itself is unchanged: the negative case below goes through it unmodified.
test.describe('journey 6: URL import', () => {
  test('imports the JSON-LD recipe from the fixture site (structured: no heuristic banner) and saves it', async ({ page, api }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill('https://nabbit-fixtures.test/pasta.html');
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.locator('input.title')).toHaveValue('Lemon Pasta');
    await expect(page.getByRole('note').filter({ hasText: 'we guessed at the layout' })).toHaveCount(0);
    await expect(page.locator('.ingredient .preview summary').nth(1)).toHaveText('240 ml cream');
    await page.locator('button.save').click();

    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Lemon Pasta' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Source' })).toHaveAttribute('href', 'https://nabbit-fixtures.test/pasta.html');
    expect((await api.recipes()).map((r) => r.title)).toEqual(['Lemon Pasta']);
  });

  test('the SSRF guard still rejects a loopback address', async ({ page }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill('https://127.0.0.1/pasta.html');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText("We can't open that address.");
    await expect(page.locator('input.title')).toHaveCount(0);
  });
});

test.describe('journey 7: photo import', () => {
  test('finds the page photo, offers it, and saves it with the recipe', async ({ page, api }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill('https://nabbit-fixtures.test/pasta.html');
    await page.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(page.getByText('Photo found, will be saved')).toBeVisible();
    await page.getByRole('button', { name: 'Show photo options' }).click();
    await expect(page.locator('button.candidate').first()).toBeVisible();
    expect(await page.locator('button.candidate').count()).toBeGreaterThanOrEqual(1);
    await page.locator('button.save').click();

    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const [saved] = await api.recipes();
    expect(saved.imageKey).toMatch(/^local-dev-user-id\//);
    const photo = page.locator('img.photo');
    await expect(photo).toBeVisible();
    await expect.poll(() => photo.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  });

  test('a page whose photo cannot be fetched saves without one and says so', async ({ page, api }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill('https://nabbit-fixtures.test/nophoto.html');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.locator('input.title')).toHaveValue('Broken Photo Pasta');
    await page.locator('button.save').click();

    await expect(page.getByText('Saved without a photo')).toBeVisible();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const [saved] = await api.recipes();
    expect(saved.imageKey ?? '').toBe('');
    await expect(page.locator('img.photo')).toHaveCount(0);
  });
});

import { expect, test } from '../fixtures/api';

const avatar = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Account menu' });

test.describe('avatar menu in the app shell', () => {
  test('shows the dev user initial, opens with name/email and Sign out, bottom nav has no Sign out', async ({ page }) => {
    await page.goto('/recipes');
    await expect(avatar(page)).toHaveText('L'); // "Local Dev User"
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByText('Sign out')).toHaveCount(0);
    await avatar(page).click();
    await expect(page.getByText('Local Dev User')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeFocused();
  });

  test('closes on navigation via the bottom nav', async ({ page }) => {
    await page.goto('/recipes');
    for (const name of ['Lists', 'Recipes']) {
      await avatar(page).click();
      await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name }).click();
      await expect(page.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0);
    }
  });

  test('Escape closes the menu and returns focus to the avatar button', async ({ page }) => {
    await page.goto('/recipes');
    await avatar(page).click();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0);
    await expect(avatar(page)).toBeFocused();
  });

  test('Sign out lands on /signin where the avatar menu and bottom nav are hidden', async ({ page }) => {
    await page.goto('/recipes');
    await avatar(page).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/signin/);
    await expect(avatar(page)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  });

  for (const size of [undefined, { width: 360, height: 740 }]) {
    test(`no horizontal overflow and the popover stays inside the viewport (${size ? '360px' : 'Pixel 7'})`, async ({ page }) => {
      if (size) await page.setViewportSize(size);
      await page.goto('/lists');
      await avatar(page).click();
      const popover = page.locator('app-avatar-menu .popover');
      await expect(popover).toBeVisible();
      const box = (await popover.boundingBox())!;
      const vp = page.viewportSize()!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
      expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test('focus and scrollIntoView keep targets clear of the sticky top bar (scroll-padding)', async ({ page }) => {
    await page.goto('/recipes');
    await expect(avatar(page)).toBeVisible();
    // Tall page with a focusable target at the top; scroll well past it, then bring it back.
    await page.evaluate(() => {
      const main = document.querySelector('main.content')!;
      const target = document.createElement('button');
      target.id = 'probe-target';
      target.textContent = 'probe';
      const spacer = document.createElement('div');
      spacer.style.height = '3000px';
      main.prepend(spacer);
      main.prepend(target);
      window.scrollTo(0, 2000);
    });
    const barBottom = async () => {
      const b = (await page.locator('.top-bar').boundingBox())!;
      return b.y + b.height;
    };
    await page.locator('#probe-target').focus();
    expect((await page.locator('#probe-target').boundingBox())!.y).toBeGreaterThanOrEqual(await barBottom());

    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.evaluate(() => document.getElementById('probe-target')!.scrollIntoView());
    expect((await page.locator('#probe-target').boundingBox())!.y).toBeGreaterThanOrEqual(await barBottom());
  });
});

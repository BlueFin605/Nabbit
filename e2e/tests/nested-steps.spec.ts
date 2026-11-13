import { expect, test } from '../fixtures/api';
import type { Locator, Page } from '@playwright/test';

const SAUCE_RECIPE = [
  'Preheat the oven.',
  { heading: 'For the sauce', steps: ['Melt the butter.', 'Whisk in the flour.', { heading: 'Spices', steps: ['Add the paprika.'] }] },
];

/** The text of every step textarea, in DOM (document) order. */
const stepTexts = (page: Page) => page.locator('textarea.step').evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));
const groupHeadings = (page: Page) => page.locator('input.group-heading').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const groupBody = (group: Locator) => group.locator('> .group-body');

test.describe('nested step groups', () => {
  test('build in the editor, save, view with headings and restarted numbering, re-open the editor', async ({ page, api }) => {
    const seeded = await api.seedRecipe('Cheese Sauce', ['Preheat the oven.']);
    await page.goto(`/recipes/${seeded.id}/edit`);
    await expect(page.locator('textarea.step')).toHaveCount(1);

    // A top-level group, then pull a new top-level step into it with Indent.
    await page.locator('[data-add="root"] .add-group').click();
    const sauce = page.locator('.group-row').first();
    await sauce.locator('> .group-head input.group-heading').fill('For the sauce');
    await page.locator('[data-add="root"] .add-step').click();
    await expect(page.locator('textarea.step')).toHaveCount(2);
    await page.locator('textarea.step').last().fill('Melt the butter.');
    await page.getByRole('button', { name: 'Indent step 2' }).click();
    await expect(groupBody(sauce).locator('textarea.step')).toHaveCount(1);

    // A second step added at the group's own level, then a nested group with one step.
    await groupBody(sauce).locator('.add-step').last().click();
    await expect(groupBody(sauce).locator('textarea.step')).toHaveCount(2);
    await page.getByRole('textbox', { name: 'Step 2' }).fill('Whisk in the flour.');
    await groupBody(sauce).locator('.add-group').last().click();
    const spices = page.locator('.group-row').nth(1);
    await spices.locator('> .group-head input.group-heading').fill('Spices');
    await groupBody(spices).locator('.add-step').click();
    await expect(groupBody(spices).locator('textarea.step')).toHaveCount(1);
    await groupBody(spices).locator('textarea.step').fill('Add the paprika.');

    await page.locator('button.save').click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${seeded.id}$`));

    // Stored as a tree.
    expect((await api.recipe(seeded.id)).steps).toEqual(SAUCE_RECIPE);

    // Recipe view: headings, one numbered list per level (numbering restarts inside each group).
    const steps = page.locator('ol.steps');
    await expect(steps.locator('> li:not(.group)')).toHaveText(['Preheat the oven.']);
    await expect(steps.getByRole('heading', { level: 3 })).toHaveText(['For the sauce', 'Spices']);
    const sauceOl = steps.locator('> li.group').first().locator('> ol');
    await expect(sauceOl.locator('> li:not(.group)')).toHaveText(['Melt the butter.', 'Whisk in the flour.']);
    await expect(sauceOl.locator('> li.group ol > li')).toHaveText(['Add the paprika.']);
    // Numbering restarts per level. A group <li> must not be a list-item (it would consume a number in its
    // parent ol), so use the browser's computed display: ordinal = position among list-item siblings only.
    const rendered = await page.locator('ol.steps li').evaluateAll((lis) =>
      lis.map((li) => {
        const display = getComputedStyle(li).display;
        const siblings = Array.from(li.parentElement!.children).filter((c) => getComputedStyle(c).display === 'list-item');
        return { group: li.classList.contains('group'), display, ordinal: display === 'list-item' ? siblings.indexOf(li) + 1 : 0 };
      }),
    );
    expect(rendered.filter((r) => r.group).map((r) => r.display)).not.toContain('list-item');
    expect(rendered.filter((r) => !r.group).map((r) => r.ordinal)).toEqual([1, 1, 2, 1]);

    // Re-open the editor: structure preserved.
    await page.getByRole('link', { name: 'Edit' }).click();
    await expect(page.locator('textarea.step')).toHaveCount(4);
    expect(await groupHeadings(page)).toEqual(['For the sauce', 'Spices']);
    expect(await stepTexts(page)).toEqual(['Preheat the oven.', 'Melt the butter.', 'Whisk in the flour.', 'Add the paprika.']);
    const sauce2 = page.locator('.group-row').first();
    await expect(groupBody(sauce2).locator('> .level > .step-row')).toHaveCount(2);
    await expect(groupBody(sauce2).locator('> .level > .group-row')).toHaveCount(1);
  });

  test('an existing flat recipe still renders as a flat numbered list', async ({ page, api }) => {
    const r = await api.seedRecipe('Fluffy Pancakes');
    await page.goto(`/recipes/${r.id}`);
    const steps = page.locator('ol.steps');
    await expect(steps.locator('> li')).toHaveCount(2);
    await expect(steps.locator('li.group')).toHaveCount(0);
    await expect(steps.getByRole('heading', { level: 3 })).toHaveCount(0);
  });

  test('a structured import with HowToSection shows groups with headings in the preview and saves them', async ({ page, api }) => {
    await page.goto('/import');
    await page.getByLabel('Paste a link or recipe text').fill('https://nabbit-fixtures.test/sections.html');
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.locator('input.title')).toHaveValue('Layered Lasagne');
    expect(await groupHeadings(page)).toEqual(['For the ragu', 'For the white sauce']);
    expect(await stepTexts(page)).toEqual([
      'Heat the oven to 180C.', 'Brown the mince.', 'Add the tomatoes and simmer.', 'Warm the milk and whisk until thick.',
    ]);
    await page.locator('button.save').click();
    await expect(page).toHaveURL(/\/recipes\/[\w-]+$/);
    const [summary] = await api.recipes();
    const saved = await api.recipe(summary.id);
    expect(saved.steps).toEqual([
      'Heat the oven to 180C.',
      { heading: 'For the ragu', steps: ['Brown the mince.', 'Add the tomatoes and simmer.'] },
      { heading: 'For the white sauce', steps: ['Warm the milk and whisk until thick.'] },
    ]);
    await expect(page.locator('ol.steps').getByRole('heading', { level: 3 })).toHaveText(['For the ragu', 'For the white sauce']);
  });

  test('drag-and-drop reorders within a level, nested inside a group', async ({ page, api }) => {
    const r = await api.seedRecipe('Cheese Sauce', ['Top A', 'Top B', { heading: 'Inner', steps: ['One', 'Two', 'Three'] }]);
    await page.goto(`/recipes/${r.id}/edit`);
    const inner = page.locator('.group-row').first();
    const rows = groupBody(inner).locator('> .level > .step-row');
    await expect(rows).toHaveCount(3);

    // Drag "One" to below "Three" by its handle, with explicit steps so the CDK sees real pointer movement.
    await rows.nth(2).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, -150)); // keep the first handle clear of the sticky top bar
    const f = (await rows.nth(0).locator('.handle').boundingBox())!;
    const t = (await rows.nth(2).boundingBox())!;
    const x = f.x + f.width / 2;
    const y = f.y + f.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 10, { steps: 5 });
    await page.mouse.move(x, t.y + t.height - 4, { steps: 25 });
    await page.mouse.up();

    await expect.poll(() => stepTexts(page)).toEqual(['Top A', 'Top B', 'Two', 'Three', 'One']);
    await page.locator('button.save').click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${r.id}$`));
    expect((await api.recipe(r.id)).steps).toEqual(['Top A', 'Top B', { heading: 'Inner', steps: ['Two', 'Three', 'One'] }]);
  });

  test('removing a non-empty group asks first: Cancel keeps it, Remove deletes group and children', async ({ page, api }) => {
    const r = await api.seedRecipe('Cheese Sauce', ['Keep me.', { heading: 'Doomed', steps: ['Child one', 'Child two'] }]);
    await page.goto(`/recipes/${r.id}/edit`);
    await expect(page.locator('textarea.step')).toHaveCount(3);

    await page.getByRole('button', { name: 'Remove group "Doomed"' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Remove this group?');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('textarea.step')).toHaveCount(3);
    await expect(page.locator('.group-row')).toHaveCount(1);

    await page.getByRole('button', { name: 'Remove group "Doomed"' }).click();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.group-row')).toHaveCount(0);
    expect(await stepTexts(page)).toEqual(['Keep me.']);

    await page.locator('button.save').click();
    await expect(page).toHaveURL(new RegExp(`/recipes/${r.id}$`));
    expect((await api.recipe(r.id)).steps).toEqual(['Keep me.']);
  });

  test('a three-level nested recipe fits a 360px viewport in the editor without horizontal overflow', async ({ page, api }) => {
    const r = await api.seedRecipe('Deep Recipe', [
      'Top step.',
      { heading: 'Level one', steps: ['One step.', { heading: 'Level two', steps: ['Two step.', { heading: 'Level three', steps: ['Three step.'] }] }] },
    ]);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/recipes/${r.id}/edit`);
    await expect(page.locator('textarea.step')).toHaveCount(4);
    const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(dims.scroll).toBeLessThanOrEqual(dims.client);
    const widths = await page.locator('textarea.step').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(120);
    const deepest = page.locator('textarea.step').last();
    await deepest.fill('Typed at the deepest level.');
    await expect(deepest).toHaveValue('Typed at the deepest level.');
  });
});

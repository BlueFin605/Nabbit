// Captures the help and landing screenshots against the LOCAL e2e stack only (demo data, no AWS).
// Usage: npm run stack:up -w e2e && npm run help:screenshots   (optionally: -- <shot-name> ...)
// Seeds demo recipes and a shopping list through the dev API, drives the built PWA, optimises PNGs with sharp.
import { chromium, devices, request } from '@playwright/test';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ports } from '../scripts/ports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helpDir = path.join(root, 'docs', 'help', 'images');
const landingDir = path.join(root, 'frontend', 'src', 'assets', 'screens');
mkdirSync(helpDir, { recursive: true });
mkdirSync(landingDir, { recursive: true });
const only = process.argv.slice(2);
const want = (n) => only.length === 0 || only.includes(n);

const base = `http://127.0.0.1:${ports.frontend}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ alg: 'none' })}.${b64({ sub: 'local-dev-user-id' })}.dev`; // fixed dev user of the e2e stack
const api = await request.newContext({ baseURL: `http://127.0.0.1:${ports.backend}`, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
const alive = await api.get('/recipes').catch(() => null);
if (!alive?.ok()) { console.error('e2e stack is not up. Run: npm run stack:up -w e2e'); process.exit(1); }

const ing = (id, name, quantity, unit, extra = {}) => ({ id, name, quantity, unit, scalable: quantity !== null, ...extra });
const post = async (body) => (await api.post('/recipes', { data: body })).json();
const recipeBodies = [
  { title: 'Fluffy Pancakes', servings: 4, tags: ['breakfast'], steps: ['Whisk the flour and milk together.', 'Cook in a hot pan until golden.'],
    ingredients: [ing('i-flour', 'plain flour', 300, 'g'), ing('i-milk', 'milk', 400, 'ml'), ing('i-butter', 'butter', 50, 'g'), ing('i-eggs', 'eggs', 2, ''), ing('i-salt', 'salt', null, '')] },
  { title: 'Sunday Lasagne', servings: 6, tags: ['dinner'], steps: [
      { heading: 'For the ragu', steps: ['Brown the mince.', 'Add the tomatoes and simmer for 30 minutes.'] },
      { heading: 'For the white sauce', steps: ['Melt the butter.', 'Whisk in the flour, then the milk.'] },
      'Layer everything with pasta sheets and bake for 40 minutes.'],
    ingredients: [ing('i-mince', 'beef mince', 500, 'g'), ing('i-tom', 'tinned tomatoes', 800, 'g'), ing('i-pasta', 'lasagne sheets', 250, 'g'), ing('i-milk', 'milk', 500, 'ml'), ing('i-cheese', 'cheddar', 150, 'g')] },
  { title: 'Tomato Soup', servings: 4, tags: ['lunch'], steps: ['Soften the onion.', 'Add tomatoes and stock; simmer, then blend.'],
    ingredients: [ing('i-on', 'onion', 1, ''), ing('i-tom', 'tinned tomatoes', 800, 'g'), ing('i-stock', 'vegetable stock', 500, 'ml')] },
  { title: 'Banana Bread', servings: 8, tags: ['baking'], steps: ['Mash the bananas.', 'Fold in the dry ingredients and bake for 55 minutes.'],
    ingredients: [ing('i-ban', 'ripe bananas', 3, ''), ing('i-fl', 'plain flour', 250, 'g'), ing('i-su', 'sugar', 150, 'g')] },
];

async function reset() {
  for (const r of await (await api.get('/recipes')).json()) await api.delete(`/recipes/${r.id}`);
  for (const l of await (await api.get('/lists')).json()) await api.delete(`/lists/${l.id}`);
}

const optimise = async (buf, file, width) => {
  let img = sharp(buf);
  if (width) img = img.resize({ width, withoutEnlargement: true });
  writeFileSync(file, await img.png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toBuffer());
  console.log('wrote', path.relative(root, file));
};

const browser = await chromium.launch();
const ctxFor = (kind) => browser.newContext(kind === 'phone' ? { ...devices['Pixel 7'], baseURL: base } : { viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1, baseURL: base });
async function shot(page, name, { dir = helpDir, width } = {}) {
  await page.waitForTimeout(500);
  await optimise(await page.screenshot(), path.join(dir, `${name}.png`), width);
}
const importUrl = async (page, url) => {
  await page.goto('/import');
  await page.getByLabel('Paste a link or recipe text').fill(url);
};
const clickImport = (page) => page.getByRole('button', { name: 'Import', exact: true }).click();

try {
  for (const kind of ['phone', 'desktop']) {
    const suffix = kind === 'phone' ? '-phone' : '';
    const ctx = await ctxFor(kind);
    const page = await ctx.newPage();
    const open = async (p) => { await page.goto(p); await page.waitForLoadState('networkidle'); };

    await reset();
    // photo recipe via a real (fixture) URL import, then the demo recipes
    await importUrl(page, 'https://nabbit-fixtures.test/pasta.html');
    if (want('import-url')) await shot(page, `import-url${suffix}`);
    await clickImport(page);
    await page.getByRole('heading', { level: 1, name: 'Lemon Pasta' }).waitFor();
    if (want('import-preview')) await shot(page, `import-preview${suffix}`);
    await page.locator('button.save').first().click();
    await page.waitForURL(/\/recipes\/[\w-]+$/);
    const recipes = {};
    for (const b of recipeBodies) recipes[b.title] = await post(b);

    if (want('recipes')) { await open('/recipes'); await shot(page, `recipes${suffix}`); }

    // YouTube import (fixture video whose description links a recipe page)
    if (want('import-youtube')) {
      await importUrl(page, 'https://yt.nabbit-fixtures.test/watch?v=YTlinked001');
      await clickImport(page);
      await page.locator('h1').first().waitFor();
      await shot(page, `import-youtube${suffix}`);
    }

    if (want('scale-servings') || want('hero')) {
      await open(`/recipes/${recipes['Sunday Lasagne'].id}`);
      if (want('hero') && kind === 'phone') await shot(page, 'hero', { dir: landingDir, width: 780 });
      for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'More servings' }).click();
      await page.waitForTimeout(200);
      if (want('scale-servings')) await shot(page, `scale-servings${suffix}`);
    }
    if (want('scale-ingredient') || want('scale')) {
      await open(`/recipes/${recipes['Fluffy Pancakes'].id}`);
      await page.locator('select.scale-by').selectOption({ label: 'plain flour' });
      await page.locator('input.anchor-amount').fill('450');
      await page.waitForTimeout(300);
      if (want('scale-ingredient')) await shot(page, `scale-ingredient${suffix}`);
      if (kind === 'phone' && want('scale')) await shot(page, 'scale', { dir: landingDir, width: 780 });
    }
    // shopping list: use the Add to list dialog on three recipes
    const addToList = async (title, snap) => {
      await open(`/recipes/${recipes[title].id}`);
      await page.getByRole('button', { name: 'Add to list' }).click();
      const dlg = page.getByRole('dialog');
      await dlg.waitFor();
      if (snap && want('add-to-list')) await shot(page, `add-to-list${suffix}`);
      await dlg.getByRole('button', { name: /^Add \d+ items?$/ }).click();
      await page.waitForTimeout(500);
    };
    await addToList('Sunday Lasagne', true);
    await addToList('Tomato Soup', false);
    await addToList('Fluffy Pancakes', false);
    await open('/lists');
    const first = page.locator('button.item').first();
    await first.waitFor();
    await first.click(); // one ticked item for the picture
    if (want('shopping-list')) await shot(page, `shopping-list${suffix}`);
    if (kind === 'phone' && want('lists')) await shot(page, 'lists', { dir: landingDir, width: 780 });

    if (want('avatar-menu')) {
      await open('/recipes');
      await page.getByRole('button', { name: 'Account menu' }).click();
      await shot(page, `avatar-menu${suffix}`);
      await page.keyboard.press('Escape');
    }
    if (kind === 'phone' && want('import')) {
      await importUrl(page, 'https://nabbit-fixtures.test/pasta.html');
      await clickImport(page);
      await page.getByRole('heading', { level: 1, name: 'Lemon Pasta' }).waitFor();
      await shot(page, 'import', { dir: landingDir, width: 780 });
    }
    await ctx.close();
  }
} finally {
  await reset();
  await browser.close();
  await api.dispose();
}

// Seeds a local dev user's sample recipes and one shopping list through the real HTTP API.
//   npm run seed                 (from the repo root or backend/)
//   node scripts/seed-local.mjs [--reset] [--api-url <url>] [--sub <ownerId>]
// Env: NABBIT_API_URL (default http://localhost:3000), NABBIT_SEED_SUB (default dev-user).
// The backend must be running with NODE_ENV=development (X-Dev-Sub is ignored otherwise).
// Idempotent: recipes are matched by title and the list by name, and anything already present is left alone.
// --reset first deletes the seeded recipes (soft delete) and the seeded list for the seed user, then recreates them.
// Only the seed user's own data is ever touched; other owners are unreachable through the API.
import { pathToFileURL } from 'node:url';

const ing = (quantity, unit, name, extra = {}) => ({ quantity, unit, name, scalable: true, ...extra });

/** Recipe bodies for POST /recipes (the server assigns ids and metric amounts). */
export const RECIPES = [
  {
    title: 'Weeknight Spaghetti Bolognese',
    servings: 4,
    tags: ['dinner', 'pasta', 'metric'],
    ingredients: [
      ing(500, 'g', 'beef mince'),
      ing(1, '', 'onion', { note: 'finely diced' }),
      ing(2, '', 'garlic cloves', { note: 'crushed' }),
      ing(400, 'g', 'tinned chopped tomatoes'),
      ing(2, 'tbsp', 'tomato paste'),
      ing(250, 'ml', 'beef stock'),
      ing(400, 'g', 'spaghetti'),
      ing(null, '', 'salt and pepper', { scalable: false }),
    ],
    steps: [
      'Brown the mince in a large pan over high heat, breaking it up, then remove it.',
      'Soften the onion and garlic in the same pan for 5 minutes.',
      'Return the mince, add the tomatoes, paste and stock, and simmer for 30 minutes.',
      'Cook the spaghetti in salted water, drain, and toss through the sauce.',
    ],
  },
  {
    title: 'Fluffy American Pancakes',
    servings: 4,
    tags: ['breakfast', 'us-units'],
    ingredients: [
      ing(1.5, 'cup', 'all-purpose flour'),
      ing(3.5, 'tsp', 'baking powder'),
      ing(1, 'tbsp', 'sugar'),
      ing(1.25, 'cup', 'milk'),
      ing(3, 'tbsp', 'butter', { note: 'melted' }),
      ing(1, '', 'egg'),
      ing(4, 'oz', 'blueberries', { note: 'optional' }),
    ],
    steps: [
      'Whisk the flour, baking powder, sugar and a pinch of salt together.',
      'Beat in the milk, melted butter and egg until just combined; lumps are fine.',
      'Heat a griddle to 375°F and grease lightly.',
      'Pour 1/4 cup of batter per pancake, scatter on blueberries, and flip when bubbles form, about 2 minutes a side.',
    ],
  },
  {
    title: 'Roast Chicken and Potatoes',
    servings: 6,
    tags: ['dinner', 'us-units'],
    ingredients: [
      ing(4, 'lb', 'whole chicken'),
      ing(2, 'lb', 'baby potatoes', { note: 'halved' }),
      ing(2, 'tbsp', 'olive oil'),
      ing(1, 'tsp', 'dried thyme'),
      ing(1, '', 'lemon', { note: 'halved' }),
    ],
    steps: [
      'Heat the oven to 425°F.',
      'Rub the chicken with oil, thyme, salt and pepper, and put the lemon in the cavity.',
      'Roast with the potatoes around it for 1 hour 15 minutes, until the juices run clear (165°F at the thigh).',
      'Rest for 15 minutes before carving.',
    ],
  },
  {
    title: 'Simple Vegetable Soup',
    servings: 6,
    tags: ['soup', 'vegetarian'],
    ingredients: [
      ing(2, '', 'carrots'),
      ing(2, '', 'celery stalks'),
      ing(1, '', 'onion'),
      ing(2, 'tbsp', 'olive oil'),
      ing(1, 'l', 'vegetable stock'),
      ing(2, 'cup', 'water', { quantityMax: 3, note: 'to adjust thickness' }),
      ing(null, '', 'salt', { note: 'to taste', scalable: false }),
      ing(null, '', 'black pepper', { note: 'to taste', scalable: false }),
    ],
    steps: [
      'Dice the carrots, celery and onion.',
      'Soften them in the oil for 8 minutes.',
      'Add the stock and 2 to 3 cups of water, then simmer for 25 minutes.',
      'Season with salt and pepper to taste.',
    ],
  },
  {
    title: 'Banana Bread',
    servings: 8,
    tags: ['baking', 'dessert', 'family-favourite'],
    sourceUrl: 'https://example.com/recipes/banana-bread',
    ingredients: [
      ing(3, '', 'ripe bananas'),
      ing(75, 'g', 'butter', { note: 'melted' }),
      ing(150, 'g', 'sugar'),
      ing(1, '', 'egg'),
      ing(1, 'tsp', 'baking soda'),
      ing(225, 'g', 'plain flour'),
    ],
    steps: [
      'Heat the oven to 175°C and line a loaf tin.',
      'Mash the bananas and stir in the butter, sugar and egg.',
      'Fold in the baking soda and flour until just combined.',
      'Bake for 55 to 60 minutes.',
    ],
  },
  {
    title: 'Overnight Oats',
    servings: 1,
    tags: ['breakfast', 'quick'],
    ingredients: [
      ing(0.5, 'cup', 'rolled oats'),
      ing(0.5, 'cup', 'milk'),
      ing(0.25, 'cup', 'plain yoghurt'),
      ing(1, 'tbsp', 'honey'),
      ing(0.25, 'cup', 'mixed berries', { note: 'swap for whatever fruit is in season' }),
    ],
    steps: [
      'Stir everything except the berries together in a jar.',
      'Refrigerate overnight.',
      'Top with the berries and serve cold.',
    ],
  },
];

export const LIST_NAME = 'Shopping';

/** Items for the seeded list; the ones in CHECKED are ticked off afterwards. */
export const LIST_ITEMS = [
  { name: 'Bananas', category: 'Produce' },
  { name: 'Carrots', category: 'Produce' },
  { name: 'Lemons', category: 'Produce' },
  { name: 'Milk', category: 'Dairy' },
  { name: 'Butter', category: 'Dairy' },
  { name: 'Eggs', category: 'Dairy' },
  { name: 'Beef mince', category: 'Meat' },
  { name: 'Spaghetti', category: 'Pantry' },
  { name: 'Olive oil', category: 'Pantry' },
  { name: 'Rolled oats', category: 'Pantry' },
  { name: 'Dish soap', category: 'Household' },
];
export const CHECKED = ['Milk', 'Spaghetti'];

/**
 * Seeds the data and returns a summary. `fetchImpl` is injectable for tests.
 * @param {{ apiUrl?: string, sub?: string, reset?: boolean, log?: (m: string) => void, fetchImpl?: typeof fetch }} [opts]
 */
export async function seed(opts = {}) {
  const apiUrl = (opts.apiUrl ?? process.env.NABBIT_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const sub = opts.sub ?? process.env.NABBIT_SEED_SUB ?? 'dev-user';
  const log = opts.log ?? (() => {});
  const doFetch = opts.fetchImpl ?? fetch;

  async function call(method, path, body, okStatuses) {
    const res = await doFetch(`${apiUrl}${path}`, {
      method,
      headers: { 'x-dev-sub': sub, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!okStatuses.includes(res.status)) {
      throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? undefined : await res.json();
  }

  const summary = {
    apiUrl,
    sub,
    recipesCreated: 0,
    recipesSkipped: 0,
    recipesDeleted: 0,
    listCreated: false,
    listsDeleted: 0,
    items: 0,
    checked: 0,
  };

  if (opts.reset) {
    const titles = new Set(RECIPES.map((r) => r.title));
    for (const r of await call('GET', '/recipes', undefined, [200])) {
      if (titles.has(r.title)) {
        await call('DELETE', `/recipes/${r.id}`, undefined, [204]);
        summary.recipesDeleted++;
      }
    }
    for (const l of await call('GET', '/lists', undefined, [200])) {
      if (l.name === LIST_NAME) {
        await call('DELETE', `/lists/${l.id}`, undefined, [204]);
        summary.listsDeleted++;
      }
    }
  }

  const haveRecipes = new Set((await call('GET', '/recipes', undefined, [200])).map((r) => r.title));
  for (const recipe of RECIPES) {
    if (haveRecipes.has(recipe.title)) {
      summary.recipesSkipped++;
      continue;
    }
    await call('POST', '/recipes', recipe, [201]);
    summary.recipesCreated++;
    log(`recipe created: ${recipe.title}`);
  }

  const existing = (await call('GET', '/lists', undefined, [200])).find((l) => l.name === LIST_NAME);
  if (existing) {
    summary.items = existing.itemCount;
    log(`list "${LIST_NAME}" already exists; left alone`);
  } else {
    const list = await call('POST', '/lists', { name: LIST_NAME }, [201]);
    let current = await call('POST', `/lists/${list.id}/items`, { items: LIST_ITEMS }, [201]);
    for (const name of CHECKED) {
      const item = current.items.find((i) => i.name === name);
      current = await call('PATCH', `/lists/${list.id}/items/${item.id}`, { checked: true }, [200]);
    }
    summary.listCreated = true;
    summary.items = current.items.length;
    summary.checked = current.items.filter((i) => i.checked).length;
    log(`list created: ${LIST_NAME}`);
  }
  return summary;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reset') out.reset = true;
    else if (argv[i] === '--api-url') out.apiUrl = argv[++i];
    else if (argv[i] === '--sub') out.sub = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const s = await seed({ ...parseArgs(process.argv.slice(2)), log: console.log });
    console.log(
      `Seeded ${s.apiUrl} as "${s.sub}": recipes ${s.recipesCreated} created / ${s.recipesSkipped} already present` +
        (s.recipesDeleted ? ` (${s.recipesDeleted} reset)` : '') +
        `; list "${LIST_NAME}" ${s.listCreated ? `created with ${s.items} items (${s.checked} checked)` : `already present (${s.items} items)`}.`,
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

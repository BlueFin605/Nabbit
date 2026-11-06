import { readFileSync } from 'node:fs';
import { test as base, expect, request, type APIRequestContext } from '@playwright/test';
import { ports } from '../scripts/ports.mjs';

/** Must match MOCK_USER.userId in frontend/src/app/core/auth/auth.ts (the disableAuth dev user). */
export const DEV_SUB = 'local-dev-user-id';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64url({ alg: 'none' })}.${b64url({ sub: DEV_SUB })}.dev`;

export const PANCAKES = readFileSync(new URL('./pancakes.txt', import.meta.url), 'utf8');

export interface ApiRecipe {
  id: string;
  title: string;
  servings: number;
  version: number;
  ingredients: { name: string; quantity: number | null; unit: string }[];
}

export class Api {
  constructor(private readonly ctx: APIRequestContext) {}

  private async json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
    expect(res.ok(), `${res.url()} -> ${res.status()}`).toBeTruthy();
    return (await res.json()) as T;
  }

  recipes() {
    return this.ctx.get('/recipes').then((r) => this.json<ApiRecipe[]>(r));
  }
  recipe(id: string) {
    return this.ctx.get(`/recipes/${id}`).then((r) => this.json<ApiRecipe>(r));
  }

  /**
   * Save the Fluffy Pancakes recipe straight through POST /recipes (not the importer, so seeding does not
   * burn the 30 imports/hour rate limit). Same shape the importer produces for pancakes.txt.
   */
  async seedRecipe(): Promise<ApiRecipe> {
    const ing = (id: string, name: string, quantity: number | null, unit: string, extra: object = {}) => ({
      id, name, quantity, unit, scalable: quantity !== null, ...extra,
    });
    const recipe = {
      title: 'Fluffy Pancakes',
      servings: 4,
      tags: [],
      steps: ['Whisk the flour and milk together.', 'Cook in a hot pan at 176°C until golden.'],
      ingredients: [
        ing('i-flour', 'all-purpose flour', 2, 'cup', { original: '2 cups all-purpose flour', metric: { quantity: 480, unit: 'ml' } }),
        ing('i-milk', 'milk', 1, 'cup', { original: '1 cup milk', metric: { quantity: 240, unit: 'ml' } }),
        ing('i-butter', 'butter', 200, 'g', { original: '200 g butter' }),
        ing('i-eggs', 'eggs', 2, '', { original: '2 eggs' }),
        ing('i-salt', 'salt to taste', null, '', { original: 'salt to taste' }),
      ],
    };
    return this.json<ApiRecipe>(await this.ctx.post('/recipes', { data: recipe }));
  }

  /** Remove everything the dev user owns (recipes soft-delete; lists hard-delete). */
  async reset(): Promise<void> {
    for (const r of await this.recipes()) expect((await this.ctx.delete(`/recipes/${r.id}`)).ok()).toBeTruthy();
    const lists = await this.json<{ id: string }[]>(await this.ctx.get('/lists'));
    for (const l of lists) expect((await this.ctx.delete(`/lists/${l.id}`)).ok()).toBeTruthy();
  }
}

export const test = base.extend<{ api: Api }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their first argument
  api: async ({}, use) => {
    const ctx = await request.newContext({
      baseURL: `http://127.0.0.1:${ports.backend}`,
      extraHTTPHeaders: { authorization: `Bearer ${token}` },
    });
    const api = new Api(ctx);
    await api.reset(); // every test starts from an empty account
    await use(api);
    await ctx.dispose();
  },
});

export { expect };

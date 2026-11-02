import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../environments/environment';
import { ApiClient } from './api-client';
import type { RecipeInput } from './api.types';

const B = environment.apiBaseUrl;

describe('ApiClient', () => {
  let api: ApiClient;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ApiClient);
    ctrl = TestBed.inject(HttpTestingController);
  });
  afterEach(() => ctrl.verify());

  const recipe: RecipeInput = { title: 'T', servings: 2, ingredients: [], steps: [], tags: [] };

  it('lists recipes with query params', () => {
    api.listRecipes({ q: 'egg', tag: 'quick' }).subscribe();
    const r = ctrl.expectOne((req) => req.url === `${B}/recipes`);
    expect(r.request.method).toBe('GET');
    expect(r.request.params.get('q')).toBe('egg');
    expect(r.request.params.get('tag')).toBe('quick');
    r.flush([]);
  });

  it('omits empty query params', () => {
    api.listRecipes().subscribe();
    const r = ctrl.expectOne(`${B}/recipes`);
    expect(r.request.params.keys()).toEqual([]);
    r.flush([]);
  });

  it('gets, creates, updates (with version), deletes and restores recipes', () => {
    api.getRecipe('a b').subscribe();
    ctrl.expectOne({ method: 'GET', url: `${B}/recipes/a%20b` }).flush({});

    api.createRecipe(recipe).subscribe();
    expect(ctrl.expectOne({ method: 'POST', url: `${B}/recipes` }).request.body).toEqual(recipe);

    api.updateRecipe('r1', recipe, 3).subscribe();
    const put = ctrl.expectOne({ method: 'PUT', url: `${B}/recipes/r1` });
    expect(put.request.body).toEqual({ ...recipe, version: 3 });

    api.deleteRecipe('r1').subscribe();
    ctrl.expectOne({ method: 'DELETE', url: `${B}/recipes/r1` });

    api.restoreRecipe('r1').subscribe();
    ctrl.expectOne({ method: 'POST', url: `${B}/recipes/r1/restore` });
  });

  it('presigns and uploads images (file part last, no JSON)', () => {
    api.presignImageUpload('image/png').subscribe();
    const p = ctrl.expectOne({ method: 'POST', url: `${B}/recipes/images` });
    expect(p.request.body).toEqual({ contentType: 'image/png' });

    api.uploadImage({ imageKey: 'k', url: 'https://s3/up', fields: { a: '1', b: '2' }, expiresIn: 300 }, new Blob(['x'])).subscribe();
    const u = ctrl.expectOne('https://s3/up');
    const keys = [...(u.request.body as FormData).keys()];
    expect(keys).toEqual(['a', 'b', 'file']);
  });

  it('imports by url or text', () => {
    api.importRecipe({ url: 'https://example.com/r' }).subscribe();
    expect(ctrl.expectOne({ method: 'POST', url: `${B}/recipes/import` }).request.body).toEqual({
      url: 'https://example.com/r',
    });
    api.importRecipe({ text: 'Eggs' }).subscribe();
    expect(ctrl.expectOne({ method: 'POST', url: `${B}/recipes/import` }).request.body).toEqual({ text: 'Eggs' });
  });

  it('covers the list and item routes', () => {
    api.listLists().subscribe();
    ctrl.expectOne({ method: 'GET', url: `${B}/lists` });

    api.createList('Weekly').subscribe();
    expect(ctrl.expectOne({ method: 'POST', url: `${B}/lists` }).request.body).toEqual({ name: 'Weekly' });

    api.getList('l1').subscribe();
    ctrl.expectOne({ method: 'GET', url: `${B}/lists/l1` });

    api.replaceList({ id: 'l1', name: 'W', items: [], version: 2 }).subscribe();
    expect(ctrl.expectOne({ method: 'PUT', url: `${B}/lists/l1` }).request.body).toEqual({ name: 'W', items: [], version: 2 });

    api.deleteList('l1').subscribe();
    ctrl.expectOne({ method: 'DELETE', url: `${B}/lists/l1` });

    api.addItems('l1', [{ name: 'milk' }]).subscribe();
    expect(ctrl.expectOne({ method: 'POST', url: `${B}/lists/l1/items` }).request.body).toEqual({ items: [{ name: 'milk' }] });

    api.patchItem('l1', 'i1', { checked: true }).subscribe();
    expect(ctrl.expectOne({ method: 'PATCH', url: `${B}/lists/l1/items/i1` }).request.body).toEqual({ checked: true });

    api.deleteItem('l1', 'i1').subscribe();
    ctrl.expectOne({ method: 'DELETE', url: `${B}/lists/l1/items/i1` });

    api.suggestItems('mi').subscribe();
    const s = ctrl.expectOne((req) => req.url === `${B}/items/suggest`);
    expect(s.request.params.get('q')).toBe('mi');
  });
});

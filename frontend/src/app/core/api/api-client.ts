import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type {
  ImageContentType,
  ImageUpload,
  ImportRequest,
  ImportResult,
  ItemPatch,
  ItemSuggestion,
  ListSummary,
  NewListItem,
  Recipe,
  RecipeInput,
  RecipeQuery,
  RecipeSummary,
  ShoppingList,
} from './api.types';

/** Typed wrapper over every Nabbit backend route. Auth is attached by the auth interceptor. */
@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl.replace(/\/+$/, '');

  private url(path: string): string {
    return `${this.base}${path}`;
  }

  // ---- recipes ----

  listRecipes(query: RecipeQuery = {}): Observable<RecipeSummary[]> {
    let params = new HttpParams();
    if (query.q) params = params.set('q', query.q);
    if (query.tag) params = params.set('tag', query.tag);
    return this.http.get<RecipeSummary[]>(this.url('/recipes'), { params });
  }

  getRecipe(id: string): Observable<Recipe> {
    return this.http.get<Recipe>(this.url(`/recipes/${encodeURIComponent(id)}`));
  }

  createRecipe(recipe: RecipeInput): Observable<Recipe> {
    return this.http.post<Recipe>(this.url('/recipes'), recipe);
  }

  /** Full replace; `version` must be the version you loaded (409 `version_conflict` if stale). */
  updateRecipe(id: string, recipe: RecipeInput, version: number): Observable<Recipe> {
    return this.http.put<Recipe>(this.url(`/recipes/${encodeURIComponent(id)}`), { ...recipe, version });
  }

  /** Soft delete (restorable for 30 days). */
  deleteRecipe(id: string): Observable<void> {
    return this.http.delete<void>(this.url(`/recipes/${encodeURIComponent(id)}`));
  }

  restoreRecipe(id: string): Observable<Recipe> {
    return this.http.post<Recipe>(this.url(`/recipes/${encodeURIComponent(id)}/restore`), {});
  }

  // ---- images ----

  /** Presigned S3 POST. Upload with {@link uploadImage}; read the image at `${IMAGE_BASE_URL}/${imageKey}`. */
  presignImageUpload(contentType: ImageContentType): Observable<ImageUpload> {
    return this.http.post<ImageUpload>(this.url('/recipes/images'), { contentType });
  }

  /** POSTs the file to S3 using a presigned upload (no auth header: this is not the Nabbit API). */
  uploadImage(upload: ImageUpload, file: Blob): Observable<void> {
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
    form.append('file', file); // must be last
    return this.http.post<void>(upload.url, form);
  }

  /** Asks the server to fetch a third-party image into S3 (SSRF-guarded); returns the stored imageKey. */
  importImage(url: string): Observable<{ imageKey: string }> {
    return this.http.post<{ imageKey: string }>(this.url('/recipes/images/import'), { url });
  }

  // ---- import ----

  /** Parses a recipe from a URL or pasted text. Nothing is saved; preview the draft then call createRecipe. */
  importRecipe(request: ImportRequest): Observable<ImportResult> {
    return this.http.post<ImportResult>(this.url('/recipes/import'), request);
  }

  // ---- shopping lists ----

  listLists(): Observable<ListSummary[]> {
    return this.http.get<ListSummary[]>(this.url('/lists'));
  }

  createList(name: string): Observable<ShoppingList> {
    return this.http.post<ShoppingList>(this.url('/lists'), { name });
  }

  getList(id: string): Observable<ShoppingList> {
    return this.http.get<ShoppingList>(this.url(`/lists/${encodeURIComponent(id)}`));
  }

  /** Full replace; `version` must match the stored list (409 `version_conflict` otherwise). */
  replaceList(list: Pick<ShoppingList, 'id' | 'name' | 'items' | 'version'>): Observable<ShoppingList> {
    const { id, ...body } = list;
    return this.http.put<ShoppingList>(this.url(`/lists/${encodeURIComponent(id)}`), body);
  }

  deleteList(id: string): Observable<void> {
    return this.http.delete<void>(this.url(`/lists/${encodeURIComponent(id)}`));
  }

  addItems(listId: string, items: NewListItem[]): Observable<ShoppingList> {
    return this.http.post<ShoppingList>(this.url(`/lists/${encodeURIComponent(listId)}/items`), { items });
  }

  patchItem(listId: string, itemId: string, patch: ItemPatch): Observable<ShoppingList> {
    return this.http.patch<ShoppingList>(
      this.url(`/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`),
      patch,
    );
  }

  deleteItem(listId: string, itemId: string): Observable<ShoppingList> {
    return this.http.delete<ShoppingList>(
      this.url(`/lists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`),
    );
  }

  /** Autocomplete from the user's item memory (up to 8, most-used first). */
  suggestItems(q: string): Observable<ItemSuggestion[]> {
    return this.http.get<ItemSuggestion[]>(this.url('/items/suggest'), { params: new HttpParams().set('q', q) });
  }
}

import type { Recipe, RecipeDraft, ShoppingList } from '@nabbit/recipe-core';

export type { Recipe, RecipeDraft, ShoppingList };

/** Row in GET /recipes. */
export interface RecipeSummary {
  id: string;
  title: string;
  imageKey?: string;
  tags: string[];
  servings: number;
  updatedAt: string;
}

/** Editable recipe fields for POST /recipes and PUT /recipes/{id} (the server owns id, timestamps, metric). */
export type RecipeInput = Omit<Recipe, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'deletedAt'>;

export interface RecipeQuery {
  q?: string;
  tag?: string;
}

export type ImageContentType = 'image/jpeg' | 'image/png' | 'image/webp';

/** POST /recipes/images: send a multipart POST to `url` with every `fields` entry first, then the `file` part. */
export interface ImageUpload {
  imageKey: string;
  url: string;
  fields: Record<string, string>;
  expiresIn: number;
}

/** POST /recipes/import takes exactly one of url or text. */
export type ImportRequest = { url: string; text?: never } | { text: string; url?: never };

export interface ImportResult {
  draft: RecipeDraft;
  imageUrl?: string;
}

/** Error codes the importer returns with a 422. */
export type ImportErrorCode =
  | 'bad_url'
  | 'blocked_address'
  | 'too_large'
  | 'timeout'
  | 'bad_status'
  | 'not_html'
  | 'not_image'
  | 'too_many_redirects';

export interface ListSummary {
  id: string;
  name: string;
  itemCount: number;
  version: number;
  updatedAt: string;
}

export interface NewListItem {
  name: string;
  category?: string;
}

export interface ItemPatch {
  checked?: boolean;
  name?: string;
  category?: string;
}

export interface ItemSuggestion {
  name: string;
  category: string;
}

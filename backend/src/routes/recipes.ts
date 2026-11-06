/**
 * Recipe endpoints (all scoped to the caller's ownerId from the JWT; another owner's recipe is always 404):
 *   GET    /recipes?q=&tag=       list summaries (excludes soft-deleted)
 *   GET    /recipes/{id}          full recipe
 *   POST   /recipes               create from a RecipeDraft.recipe body
 *   PUT    /recipes/{id}          full replace, optimistic concurrency on `version`
 *   DELETE /recipes/{id}          soft delete (deletedAt + ttl = now + 30 days)
 *   POST   /recipes/{id}/restore  undo a soft delete within the 30 days
 * Stored as pk=OWNER#{ownerId}, sk=RECIPE#{id}; attributes are the Recipe fields plus `ttl` when deleted.
 */
import { newId, toMetric, type Ingredient, type Recipe } from '@nabbit/recipe-core';
import { ConditionFailedError, RECIPE_SK_PREFIX, getDb, ownerPk, recipeSk, type Item } from '../db.js';
import { HttpError, assertMaxBytes, route, type RequestCtx } from '../router.js';

const MAX_TITLE = 200;
const MAX_INGREDIENTS = 200;
const MAX_STEPS = 100;
const MAX_TAGS = 50;
const MAX_STRING = 5000;
/** Serialized recipe cap, well under DynamoDB's 400 KB item limit. */
const MAX_RECIPE_BYTES = 350 * 1024;
const RETENTION_DAYS = 30;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};

function str(v: unknown, field: string, max = MAX_STRING): string {
  if (typeof v !== 'string') return bad(`${field} must be a string`);
  if (v.length > max) return bad(`${field} too long`);
  return v;
}
function optStr(v: unknown, field: string): string | undefined {
  return v === undefined || v === null ? undefined : str(v, field);
}

function parseIngredient(v: unknown, i: number): Ingredient {
  if (!isObj(v)) return bad(`ingredients[${i}] must be an object`);
  const f = `ingredients[${i}]`;
  const q = v.quantity ?? null;
  if (q !== null && (typeof q !== 'number' || !Number.isFinite(q))) bad(`${f}.quantity must be a number or null`);
  if (v.quantityMax !== undefined && (typeof v.quantityMax !== 'number' || !Number.isFinite(v.quantityMax))) {
    bad(`${f}.quantityMax must be a number`);
  }
  const original = optStr(v.original, `${f}.original`);
  const note = optStr(v.note, `${f}.note`);
  const ing: Ingredient = {
    id: typeof v.id === 'string' && v.id !== '' && v.id.length <= 100 ? v.id : newId(),
    quantity: q as number | null,
    unit: str(v.unit ?? '', `${f}.unit`, 50) as Ingredient['unit'],
    name: str(v.name, `${f}.name`),
    scalable: v.scalable === undefined ? true : v.scalable === true,
    ...(original !== undefined ? { original } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(v.quantityMax !== undefined ? { quantityMax: v.quantityMax as number } : {}),
  };
  return toMetric(ing); // always recomputed server-side; any client `metric` is discarded
}

type Fields = Pick<Recipe, 'title' | 'sourceUrl' | 'imageKey' | 'servings' | 'ingredients' | 'steps' | 'tags'>;

/** Validate and normalise the client-editable recipe fields. Everything else is server-owned. */
function parseFields(body: unknown, ownerId: string): Fields {
  if (!isObj(body)) return bad('body must be a JSON object');
  const title = str(body.title, 'title').trim();
  if (title === '' || title.length > MAX_TITLE) bad(`title must be 1-${MAX_TITLE} characters`);
  if (typeof body.servings !== 'number' || !Number.isFinite(body.servings) || body.servings <= 0) {
    bad('servings must be a positive number');
  }
  if (!Array.isArray(body.ingredients) || body.ingredients.length > MAX_INGREDIENTS) {
    bad(`ingredients must be an array of at most ${MAX_INGREDIENTS}`);
  }
  if (!Array.isArray(body.steps) || body.steps.length > MAX_STEPS) bad(`steps must be an array of at most ${MAX_STEPS}`);
  const tags = body.tags ?? [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) bad(`tags must be an array of at most ${MAX_TAGS}`);
  const sourceUrl = optStr(body.sourceUrl, 'sourceUrl');
  const imageKey = optStr(body.imageKey, 'imageKey');
  // Image keys are `{ownerId}/{uuid}`; refuse to reference another owner's image.
  if (imageKey !== undefined && !imageKey.startsWith(`${ownerId}/`)) bad('imageKey is not yours');
  const fields: Fields = {
    title,
    servings: body.servings as number,
    ingredients: (body.ingredients as unknown[]).map(parseIngredient),
    steps: (body.steps as unknown[]).map((s, i) => str(s, `steps[${i}]`)),
    tags: (tags as unknown[]).map((t, i) => str(t, `tags[${i}]`)),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    ...(imageKey !== undefined ? { imageKey } : {}),
  };
  assertMaxBytes(fields, MAX_RECIPE_BYTES);
  return fields;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Strip storage-only attributes. */
function toRecipe(item: Item): Recipe {
  const { pk: _pk, sk: _sk, ttl: _ttl, ...recipe } = item;
  void _pk;
  void _sk;
  void _ttl;
  return recipe as unknown as Recipe;
}

/** Load an item the caller owns; undefined if missing or (unless `deleted`) soft-deleted or TTL-expired. */
async function load(ownerId: string, id: string, deleted = false): Promise<Item | undefined> {
  const item = await getDb().getItem(ownerPk(ownerId), recipeSk(id));
  if (!item) return undefined;
  const isDeleted = typeof item.deletedAt === 'string';
  if (isDeleted !== deleted) return undefined;
  if (isDeleted && typeof item.ttl === 'number' && item.ttl <= nowSec()) return undefined; // awaiting TTL sweep
  return item;
}

const notFound = (): never => {
  throw new HttpError(404, 'not_found');
};

async function list({ ownerId, query }: RequestCtx) {
  const items = await getDb().queryItems(ownerPk(ownerId), RECIPE_SK_PREFIX);
  const q = query.q?.trim().toLowerCase();
  const tag = query.tag;
  return {
    status: 200,
    body: items
      .filter((i) => i.deletedAt === undefined)
      .map(toRecipe)
      .filter((r) => !tag || r.tags.includes(tag))
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.ingredients.some((g) => g.name.toLowerCase().includes(q)))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((r) => ({ id: r.id, title: r.title, imageKey: r.imageKey, tags: r.tags, servings: r.servings, updatedAt: r.updatedAt })),
  };
}

async function get({ ownerId, params }: RequestCtx) {
  const item = await load(ownerId, params.id!);
  return item ? { status: 200, body: toRecipe(item) } : notFound();
}

async function create({ ownerId, body }: RequestCtx) {
  const now = new Date().toISOString();
  const recipe: Recipe = { ...parseFields(body, ownerId), id: newId(), version: 1, createdAt: now, updatedAt: now };
  await getDb().putItem({ pk: ownerPk(ownerId), sk: recipeSk(recipe.id), ...recipe }, { absent: ['pk'] });
  return { status: 201, body: recipe };
}

async function update({ ownerId, params, body }: RequestCtx) {
  const id = params.id!;
  const existing = await load(ownerId, id);
  if (!existing) return notFound();
  const fields = parseFields(body, ownerId);
  const version: unknown = (body as Obj).version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new HttpError(400, 'version is required');
  if (existing.version !== version) throw new HttpError(409, 'version_conflict');
  const recipe: Recipe = {
    ...fields,
    id,
    version: version + 1,
    createdAt: existing.createdAt as string,
    updatedAt: new Date().toISOString(),
  };
  try {
    await getDb().putItem(
      { pk: ownerPk(ownerId), sk: recipeSk(id), ...recipe },
      { exists: true, equals: { version }, absent: ['deletedAt'] },
    );
  } catch (err) {
    if (err instanceof ConditionFailedError) throw new HttpError(409, 'version_conflict');
    throw err;
  }
  return { status: 200, body: recipe };
}

async function remove({ ownerId, params }: RequestCtx) {
  const existing = await load(ownerId, params.id!);
  if (!existing) return notFound();
  const now = new Date();
  try {
    await getDb().putItem(
      {
        ...existing,
        deletedAt: now.toISOString(),
        ttl: Math.floor(now.getTime() / 1000) + RETENTION_DAYS * 86400,
      },
      { exists: true, equals: { version: existing.version }, absent: ['deletedAt'] },
    );
  } catch (err) {
    if (err instanceof ConditionFailedError) throw new HttpError(409, 'version_conflict');
    throw err;
  }
  return { status: 204 };
}

async function restore({ ownerId, params }: RequestCtx) {
  const existing = await load(ownerId, params.id!, true);
  if (!existing) return notFound();
  const { deletedAt: _d, ttl: _t, ...rest } = existing;
  void _d;
  void _t;
  const item: Item = { ...rest, version: (existing.version as number) + 1, updatedAt: new Date().toISOString() };
  try {
    await getDb().putItem(item, { exists: true, equals: { version: existing.version } });
  } catch (err) {
    if (err instanceof ConditionFailedError) throw new HttpError(409, 'version_conflict');
    throw err;
  }
  return { status: 200, body: toRecipe(item) };
}

/** Register the recipe routes (also runs once on import; tests call it again after `resetRoutes`). */
export function registerRecipeRoutes(): void {
  route('GET', '/recipes', list);
  route('GET', '/recipes/{id}', get);
  route('POST', '/recipes', create);
  route('PUT', '/recipes/{id}', update);
  route('DELETE', '/recipes/{id}', remove);
  route('POST', '/recipes/{id}/restore', restore);
}

registerRecipeRoutes();

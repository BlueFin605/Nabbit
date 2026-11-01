/**
 * Shopping list endpoints (all scoped to the caller's ownerId from the JWT; another owner's data is always 404):
 *   GET    /lists                          summaries {id, name, itemCount, version, updatedAt}
 *   POST   /lists                          {name} -> 201 ShoppingList
 *   GET    /lists/{id}                     ShoppingList
 *   PUT    /lists/{id}                     {name, items, version} full replace, 409 on stale version
 *   DELETE /lists/{id}                     204 (hard delete)
 *   POST   /lists/{id}/items               {name, category?} or {items:[...]} -> 201 ShoppingList
 *   PATCH  /lists/{id}/items/{itemId}      {checked?, name?, category?} -> 200 ShoppingList
 *   DELETE /lists/{id}/items/{itemId}      200 ShoppingList
 *   GET    /items/suggest?q=               up to 8 {name, category} from item memory, by uses desc
 * Stored as pk=OWNER#{ownerId}, sk=LIST#{id} (the ShoppingList) and sk=MEM#{lowercased name} ({category, uses}).
 */
import { newId, type ListItem, type ShoppingList } from '@nabbit/recipe-core';
import { ConditionFailedError, LIST_SK_PREFIX, MEM_SK_PREFIX, getDb, listSk, memSk, ownerPk, type Item } from '../db.js';
import { HttpError, route, type RequestCtx } from '../router.js';

const MAX_LISTS = 50;
const MAX_ITEMS = 500;
const MAX_NAME = 100;
const MAX_SUGGESTIONS = 8;
const DEFAULT_CATEGORY = 'Other';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};
const notFound = (): never => {
  throw new HttpError(404, 'not_found');
};

function name(v: unknown, field: string): string {
  if (typeof v !== 'string') return bad(`${field} must be a string`);
  const t = v.trim();
  if (t === '' || t.length > MAX_NAME) return bad(`${field} must be 1-${MAX_NAME} characters`);
  return t;
}
function category(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return name(v, field);
}

const toList = (item: Item): ShoppingList => {
  const { pk: _pk, sk: _sk, ...list } = item;
  void _pk;
  void _sk;
  return list as unknown as ShoppingList;
};

async function load(ownerId: string, id: string): Promise<ShoppingList> {
  const item = await getDb().getItem(ownerPk(ownerId), listSk(id));
  return item ? toList(item) : notFound();
}

/** Write `next` (version already bumped) iff the stored version is still `expected`; else 409. */
async function save(ownerId: string, next: ShoppingList, expected: number): Promise<void> {
  try {
    await getDb().putItem(
      { pk: ownerPk(ownerId), sk: listSk(next.id), ...next },
      { exists: true, equals: { version: expected } },
    );
  } catch (err) {
    if (err instanceof ConditionFailedError) throw new HttpError(409, 'version_conflict');
    throw err;
  }
}

/** Bump version/updatedAt and persist a modified copy of `list`. */
async function commit(ownerId: string, list: ShoppingList, items: ListItem[], listName = list.name): Promise<ShoppingList> {
  const next: ShoppingList = { id: list.id, name: listName, items, version: list.version + 1, updatedAt: new Date().toISOString() };
  await save(ownerId, next, list.version);
  return next;
}

interface Memory {
  category: string;
  uses: number;
}
async function loadMemory(ownerId: string, lower: string): Promise<Memory | undefined> {
  const m = await getDb().getItem(ownerPk(ownerId), memSk(lower));
  return m ? { category: m.category as string, uses: m.uses as number } : undefined;
}
async function writeMemory(ownerId: string, lower: string, m: Memory): Promise<void> {
  await getDb().putItem({ pk: ownerPk(ownerId), sk: memSk(lower), category: m.category, uses: m.uses });
}

async function listAll({ ownerId }: RequestCtx) {
  const rows = await getDb().queryItems(ownerPk(ownerId), LIST_SK_PREFIX);
  return {
    status: 200,
    body: rows
      .map(toList)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((l) => ({ id: l.id, name: l.name, itemCount: l.items.length, version: l.version, updatedAt: l.updatedAt })),
  };
}

async function create({ ownerId, body }: RequestCtx) {
  if (!isObj(body)) return bad('body must be a JSON object');
  const listName = name(body.name, 'name');
  const existing = await getDb().queryItems(ownerPk(ownerId), LIST_SK_PREFIX);
  if (existing.length >= MAX_LISTS) return bad(`at most ${MAX_LISTS} lists`);
  const list: ShoppingList = { id: newId(), name: listName, items: [], version: 1, updatedAt: new Date().toISOString() };
  await getDb().putItem({ pk: ownerPk(ownerId), sk: listSk(list.id), ...list }, { absent: ['pk'] });
  return { status: 201, body: list };
}

async function get({ ownerId, params }: RequestCtx) {
  return { status: 200, body: await load(ownerId, params.id!) };
}

function parseFullItem(v: unknown, i: number): ListItem {
  if (!isObj(v)) return bad(`items[${i}] must be an object`);
  if (v.checked !== undefined && typeof v.checked !== 'boolean') bad(`items[${i}].checked must be a boolean`);
  return {
    id: typeof v.id === 'string' && v.id !== '' && v.id.length <= 100 ? v.id : newId(),
    name: name(v.name, `items[${i}].name`),
    category: category(v.category, `items[${i}].category`) ?? DEFAULT_CATEGORY,
    checked: v.checked === true,
  };
}

async function replace({ ownerId, params, body }: RequestCtx) {
  const existing = await load(ownerId, params.id!);
  if (!isObj(body)) return bad('body must be a JSON object');
  const listName = name(body.name, 'name');
  if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS) bad(`items must be an array of at most ${MAX_ITEMS}`);
  const version = body.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return bad('version is required');
  if (existing.version !== version) throw new HttpError(409, 'version_conflict');
  const items = (body.items as unknown[]).map(parseFullItem);
  return { status: 200, body: await commit(ownerId, existing, items, listName) };
}

async function remove({ ownerId, params }: RequestCtx) {
  await load(ownerId, params.id!);
  await getDb().deleteItem(ownerPk(ownerId), listSk(params.id!));
  return { status: 204 };
}

interface NewItem {
  name: string;
  category?: string;
}

async function addItems({ ownerId, params, body }: RequestCtx) {
  const list = await load(ownerId, params.id!);
  if (!isObj(body)) return bad('body must be a JSON object');
  let incoming: NewItem[];
  if (body.items !== undefined) {
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_ITEMS) {
      return bad(`items must be an array of 1-${MAX_ITEMS}`);
    }
    incoming = (body.items as unknown[]).map((v, i) => {
      if (!isObj(v)) return bad(`items[${i}] must be an object`);
      const cat = category(v.category, `items[${i}].category`);
      return { name: name(v.name, `items[${i}].name`), ...(cat !== undefined ? { category: cat } : {}) };
    });
  } else {
    const cat = category(body.category, 'category');
    incoming = [{ name: name(body.name, 'name'), ...(cat !== undefined ? { category: cat } : {}) }];
  }

  const memories = new Map<string, Memory | undefined>();
  const items = list.items.map((i) => ({ ...i }));
  for (const inc of incoming) {
    const lower = inc.name.toLowerCase();
    if (!memories.has(lower)) memories.set(lower, await loadMemory(ownerId, lower));
    const prev = memories.get(lower);
    const cat = inc.category ?? prev?.category ?? DEFAULT_CATEGORY;
    memories.set(lower, { category: cat, uses: (prev?.uses ?? 0) + 1 });
    if (items.some((i) => !i.checked && i.name.toLowerCase() === lower)) continue; // merge onto existing unchecked item
    if (items.length >= MAX_ITEMS) return bad(`at most ${MAX_ITEMS} items per list`);
    items.push({ id: newId(), name: inc.name, category: cat, checked: false });
  }
  const saved = await commit(ownerId, list, items);
  for (const [lower, m] of memories) await writeMemory(ownerId, lower, m!);
  return { status: 201, body: saved };
}

async function patchItem({ ownerId, params, body }: RequestCtx) {
  const list = await load(ownerId, params.id!);
  const idx = list.items.findIndex((i) => i.id === params.itemId);
  if (idx < 0) return notFound();
  if (!isObj(body)) return bad('body must be a JSON object');
  if (body.checked !== undefined && typeof body.checked !== 'boolean') return bad('checked must be a boolean');
  const newName = body.name === undefined ? undefined : name(body.name, 'name');
  const newCat = body.category === undefined ? undefined : category(body.category, 'category');
  const cur = list.items[idx]!;
  const updated: ListItem = {
    ...cur,
    ...(body.checked !== undefined ? { checked: body.checked } : {}),
    ...(newName !== undefined ? { name: newName } : {}),
    ...(newCat !== undefined ? { category: newCat } : {}),
  };
  const items = list.items.map((i, n) => (n === idx ? updated : i));
  const saved = await commit(ownerId, list, items);
  if (newCat !== undefined) {
    const lower = updated.name.toLowerCase();
    const prev = await loadMemory(ownerId, lower);
    await writeMemory(ownerId, lower, { category: newCat, uses: prev?.uses ?? 1 });
  }
  return { status: 200, body: saved };
}

async function deleteItem({ ownerId, params }: RequestCtx) {
  const list = await load(ownerId, params.id!);
  if (!list.items.some((i) => i.id === params.itemId)) return notFound();
  const saved = await commit(ownerId, list, list.items.filter((i) => i.id !== params.itemId));
  return { status: 200, body: saved };
}

async function suggest({ ownerId, query }: RequestCtx) {
  const q = (query.q ?? '').trim().toLowerCase();
  const rows = await getDb().queryItems(ownerPk(ownerId), memSk(q));
  const out = rows
    .map((r) => ({ name: r.sk.slice(MEM_SK_PREFIX.length), category: r.category as string, uses: r.uses as number }))
    .sort((a, b) => b.uses - a.uses || (a.name < b.name ? -1 : 1))
    .slice(0, MAX_SUGGESTIONS)
    .map(({ name: n, category: c }) => ({ name: n, category: c }));
  return { status: 200, body: out };
}

/** Register the list routes (also runs once on import; tests call it again after `resetRoutes`). */
export function registerListRoutes(): void {
  route('GET', '/lists', listAll);
  route('POST', '/lists', create);
  route('GET', '/lists/{id}', get);
  route('PUT', '/lists/{id}', replace);
  route('DELETE', '/lists/{id}', remove);
  route('POST', '/lists/{id}/items', addItems);
  route('PATCH', '/lists/{id}/items/{itemId}', patchItem);
  route('DELETE', '/lists/{id}/items/{itemId}', deleteItem);
  route('GET', '/items/suggest', suggest);
}

registerListRoutes();

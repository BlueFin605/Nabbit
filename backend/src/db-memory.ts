import { ConditionFailedError, type Condition, type Db, type Item } from './db.js';

/** In-memory `Db` test double with the same conditional-write semantics as the DynamoDB one. */
export function createMemoryDb(): Db & { items: Map<string, Item> } {
  const items = new Map<string, Item>();
  const key = (pk: string, sk: string) => `${pk}\u0000${sk}`;
  const holds = (existing: Item | undefined, c?: Condition): boolean => {
    if (!c) return true;
    if (c.exists && !existing) return false;
    for (const [k, v] of Object.entries(c.equals ?? {})) if (!existing || existing[k] !== v) return false;
    for (const k of c.absent ?? []) if (existing && existing[k] !== undefined) return false;
    return true;
  };
  return {
    items,
    async getItem(pk, sk) {
      const it = items.get(key(pk, sk));
      return it ? structuredClone(it) : undefined;
    },
    async putItem(item, condition) {
      if (!holds(items.get(key(item.pk, item.sk)), condition)) throw new ConditionFailedError();
      items.set(key(item.pk, item.sk), structuredClone(item));
    },
    async deleteItem(pk, sk) {
      items.delete(key(pk, sk));
    },
    async incrementCounter(pk, sk, ttl) {
      const k = key(pk, sk);
      const count = ((items.get(k)?.count as number | undefined) ?? 0) + 1;
      items.set(k, { pk, sk, count, ttl });
      return count;
    },
    async queryItems(pk, skPrefix) {
      return [...items.values()].filter((i) => i.pk === pk && i.sk.startsWith(skPrefix)).map((i) => structuredClone(i));
    },
  };
}

import { ConditionFailedError, type Condition, type Db, type Item } from './db.js';

function stripUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => [k, stripUndefined(x)]),
    );
  }
  return v;
}

/**
 * In-memory `Db` test double. Mirrors DynamoDB for: conditional puts, undefined attributes being dropped
 * (as createDynamoDb's removeUndefinedValues does), ADD-style counters that preserve other attributes, and
 * queryItems returning items sorted by sk.
 * Documented differences (covered only by the LocalStack integration test, db-localstack.test.ts):
 *  - no 400 KB item-size limit and no 1 MB query page limit, so pagination is never exercised;
 *  - no reserved-word/expression validation, no TTL expiry, no eventual-consistency effects;
 *  - sk ordering is by UTF-16 code unit rather than UTF-8 byte (identical for BMP text);
 *  - values are structuredClone'd, so Dates/Maps survive here but not in DynamoDB marshalling.
 */
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
      items.set(key(item.pk, item.sk), stripUndefined(structuredClone(item)) as Item);
    },
    async deleteItem(pk, sk) {
      items.delete(key(pk, sk));
    },
    async incrementCounter(pk, sk, ttl) {
      const k = key(pk, sk);
      const count = ((items.get(k)?.count as number | undefined) ?? 0) + 1;
      items.set(k, { ...items.get(k), pk, sk, count, ttl });
      return count;
    },
    async bumpItemMemory(pk, sk, category, now, by) {
      const k = key(pk, sk);
      const prev = items.get(k);
      items.set(k, { ...prev, pk, sk, uses: ((prev?.uses as number | undefined) ?? 0) + by, category, updatedAt: now });
    },
    async queryItems(pk, skPrefix) {
      return [...items.values()].filter((i) => i.pk === pk && i.sk.startsWith(skPrefix)).sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0)).map((i) => structuredClone(i));
    },
  };
}

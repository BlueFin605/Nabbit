import { getDb, type Db } from './db.js';

/** Partition key of an alias item: `pk=ALIAS#{sub} sk=ALIAS` with attribute `legacySub` (the owner id the data lives under). */
export const aliasPk = (sub: string): string => `ALIAS#${sub}`;
export const ALIAS_SK = 'ALIAS';

// Per-container cache of sub -> ownerId (hits and misses alike); an alias added later is picked up on the next cold start.
const cache = new Map<string, string>();

/** Test helper: forget cached resolutions. */
export function resetOwnerCache(): void {
  cache.clear();
}

/**
 * Map a verified JWT `sub` to the owner id its data is stored under: the alias item's `legacySub` when present
 * (a shared-identity user who owns pre-migration data), otherwise the `sub` itself.
 */
export async function resolveOwner(db: Db = getDb(), sub: string): Promise<string> {
  const cached = cache.get(sub);
  if (cached !== undefined) return cached;
  const legacy = (await db.getItem(aliasPk(sub), ALIAS_SK))?.legacySub;
  const ownerId = typeof legacy === 'string' && legacy !== '' ? legacy : sub;
  cache.set(sub, ownerId);
  return ownerId;
}

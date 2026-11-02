import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db-memory.js';

describe('Db.incrementCounter', () => {
  it('atomically increments per key and sets ttl', async () => {
    const db = createMemoryDb();
    expect(await db.incrementCounter('OWNER#a', 'RATE#x', 100)).toBe(1);
    expect(await db.incrementCounter('OWNER#a', 'RATE#x', 100)).toBe(2);
    expect(await db.incrementCounter('OWNER#b', 'RATE#x', 100)).toBe(1);
    expect((await db.getItem('OWNER#a', 'RATE#x'))?.ttl).toBe(100);
  });
});

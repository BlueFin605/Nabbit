/**
 * Integration test for createDynamoDb against a real DynamoDB API (LocalStack). Skipped unless
 * NABBIT_LOCALSTACK_ENDPOINT is set, so the default `npm test` never needs a container.
 *
 * Run (table must exist; init-local.mjs creates it):
 *   docker run -d --name nabbit-it-localstack -p 127.0.0.1:4577:4566 localstack/localstack:3
 *   AWS_ENDPOINT_URL=http://127.0.0.1:4577 TABLE_NAME=nabbit-it-data node backend/scripts/init-local.mjs
 *   NABBIT_LOCALSTACK_ENDPOINT=http://127.0.0.1:4577 NABBIT_LOCALSTACK_TABLE=nabbit-it-data \
 *     npx vitest run test/db-localstack.test.ts   (from backend/)
 */
import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { ConditionFailedError, createDynamoDb } from '../src/db.js';

const endpoint = process.env.NABBIT_LOCALSTACK_ENDPOINT;
const table = process.env.NABBIT_LOCALSTACK_TABLE ?? 'nabbit-local-data';

describe.skipIf(!endpoint)('createDynamoDb against LocalStack', () => {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  const db = createDynamoDb(table, client);
  const pk = `OWNER#it-${randomUUID()}`;

  it('put/get/delete round-trips and drops undefined values', async () => {
    await db.putItem({ pk, sk: 'RECIPE#1', title: 'T', gone: undefined, nested: { a: 1, b: undefined } });
    expect(await db.getItem(pk, 'RECIPE#1')).toEqual({ pk, sk: 'RECIPE#1', title: 'T', nested: { a: 1 } });
    await db.deleteItem(pk, 'RECIPE#1');
    expect(await db.getItem(pk, 'RECIPE#1')).toBeUndefined();
    await db.deleteItem(pk, 'RECIPE#1'); // no-op on absent
  });

  it('enforces exists / equals / absent conditions', async () => {
    const sk = 'LIST#cond';
    await expect(db.putItem({ pk, sk, version: 1 }, { exists: true })).rejects.toBeInstanceOf(ConditionFailedError);
    await db.putItem({ pk, sk, version: 1 }, { absent: ['pk'] });
    await expect(db.putItem({ pk, sk, version: 9 }, { absent: ['pk'] })).rejects.toBeInstanceOf(ConditionFailedError);
    await expect(db.putItem({ pk, sk, version: 9 }, { equals: { version: 2 } })).rejects.toBeInstanceOf(ConditionFailedError);
    await db.putItem({ pk, sk, version: 2 }, { exists: true, equals: { version: 1 } });
    expect((await db.getItem(pk, sk))?.version).toBe(2);
  });

  it('incrementCounter is atomic, preserves other attributes and updates ttl', async () => {
    const sk = 'RATE#import#1';
    await db.putItem({ pk, sk, note: 'keep' });
    const counts = await Promise.all(Array.from({ length: 10 }, () => db.incrementCounter(pk, sk, 123)));
    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await db.getItem(pk, sk)).toEqual({ pk, sk, note: 'keep', count: 10, ttl: 123 });
  });

  it('bumpItemMemory creates at `by`, accumulates, and keeps other attributes', async () => {
    const sk = 'MEM#milk';
    await db.bumpItemMemory(pk, sk, 'Dairy', 't1', 1);
    expect(await db.getItem(pk, sk)).toEqual({ pk, sk, uses: 1, category: 'Dairy', updatedAt: 't1' });
    await db.putItem({ pk, sk: 'MEM#eggs', uses: 5, category: 'A', extra: 'keep' });
    await Promise.all(Array.from({ length: 5 }, () => db.bumpItemMemory(pk, 'MEM#eggs', 'B', 't2', 2)));
    expect(await db.getItem(pk, 'MEM#eggs')).toEqual({ pk, sk: 'MEM#eggs', uses: 15, category: 'B', updatedAt: 't2', extra: 'keep' });
  });

  it('queryItems filters by prefix, returns sorted by sk, and follows pagination past 1 MB', async () => {
    const big = 'x'.repeat(100_000);
    const n = 15; // ~1.5 MB total forces at least two Query pages
    for (let i = 0; i < n; i++) await db.putItem({ pk, sk: `PAGE#${String(i).padStart(3, '0')}`, big });
    await db.putItem({ pk, sk: 'OTHER#1' });
    const got = await db.queryItems(pk, 'PAGE#');
    expect(got.map((i) => i.sk)).toEqual(Array.from({ length: n }, (_, i) => `PAGE#${String(i).padStart(3, '0')}`));
  });

  it('rejects an item over the 400 KB limit (the in-memory double does not)', async () => {
    await expect(db.putItem({ pk, sk: 'RECIPE#huge', blob: 'x'.repeat(401 * 1024) })).rejects.toThrow();
  });
});

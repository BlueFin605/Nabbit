import { describe, expect, it, vi } from 'vitest';
import { ConditionFailedError, createDynamoDb } from '../src/db.js';
import { createMemoryDb } from '../src/db-memory.js';

function make(responses: unknown[] = [{}]) {
  const send = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) send.mockRejectedValueOnce(r);
    else send.mockResolvedValueOnce(r);
  }
  send.mockResolvedValue({});
  const db = createDynamoDb('tbl', { send } as never);
  const input = (n = 0) => send.mock.calls[n]![0].input as Record<string, unknown>;
  const name = (n = 0) => send.mock.calls[n]![0].constructor.name as string;
  return { db, send, input, name };
}
const failure = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

describe('createDynamoDb getItem / deleteItem', () => {
  it('sends a Get with the key and returns the item (or undefined)', async () => {
    const { db, input, name } = make([{ Item: { pk: 'p', sk: 's', a: 1 } }, {}]);
    expect(await db.getItem('p', 's')).toEqual({ pk: 'p', sk: 's', a: 1 });
    expect(name()).toBe('GetCommand');
    expect(input()).toEqual({ TableName: 'tbl', Key: { pk: 'p', sk: 's' } });
    expect(await db.getItem('p', 'missing')).toBeUndefined();
  });

  it('sends a Delete with the key', async () => {
    const { db, input, name } = make();
    await db.deleteItem('p', 's');
    expect(name()).toBe('DeleteCommand');
    expect(input()).toEqual({ TableName: 'tbl', Key: { pk: 'p', sk: 's' } });
  });
});

describe('createDynamoDb putItem conditions', () => {
  const item = { pk: 'p', sk: 's', v: 1 };

  it('sends an unconditional Put with no expression', async () => {
    const { db, input, name } = make();
    await db.putItem(item);
    expect(name()).toBe('PutCommand');
    expect(input()).toEqual({ TableName: 'tbl', Item: item });
  });

  it('exists -> attribute_exists(pk) with no names/values', async () => {
    const { db, input } = make();
    await db.putItem(item, { exists: true });
    expect(input()).toEqual({ TableName: 'tbl', Item: item, ConditionExpression: 'attribute_exists(pk)' });
  });

  it('equals -> #eN = :eN with names and values', async () => {
    const { db, input } = make();
    await db.putItem(item, { equals: { version: 3, owner: 'u1' } });
    expect(input()).toEqual({
      TableName: 'tbl',
      Item: item,
      ConditionExpression: '#e0 = :e0 AND #e1 = :e1',
      ExpressionAttributeNames: { '#e0': 'version', '#e1': 'owner' },
      ExpressionAttributeValues: { ':e0': 3, ':e1': 'u1' },
    });
  });

  it('absent -> attribute_not_exists(#aN) with names only', async () => {
    const { db, input } = make();
    await db.putItem(item, { absent: ['pk', 'ttl'] });
    expect(input()).toEqual({
      TableName: 'tbl',
      Item: item,
      ConditionExpression: 'attribute_not_exists(#a0) AND attribute_not_exists(#a1)',
      ExpressionAttributeNames: { '#a0': 'pk', '#a1': 'ttl' },
    });
  });

  it('combines exists + equals + absent with AND', async () => {
    const { db, input } = make();
    await db.putItem(item, { exists: true, equals: { version: 1 }, absent: ['deleted'] });
    expect(input()).toMatchObject({
      ConditionExpression: 'attribute_exists(pk) AND #e0 = :e0 AND attribute_not_exists(#a0)',
      ExpressionAttributeNames: { '#e0': 'version', '#a0': 'deleted' },
      ExpressionAttributeValues: { ':e0': 1 },
    });
  });

  it('an empty condition object adds no expression', async () => {
    const { db, input } = make();
    await db.putItem(item, {});
    expect(input()).toEqual({ TableName: 'tbl', Item: item });
  });

  it('maps ConditionalCheckFailedException to ConditionFailedError', async () => {
    const { db } = make([failure()]);
    await expect(db.putItem(item, { exists: true })).rejects.toBeInstanceOf(ConditionFailedError);
  });

  it('rethrows other errors unchanged', async () => {
    const boom = Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
    const { db } = make([boom]);
    await expect(db.putItem(item)).rejects.toBe(boom);
  });
});

describe('createDynamoDb counters', () => {
  it('incrementCounter sends ADD count + SET ttl with UPDATED_NEW and returns the new count', async () => {
    const { db, input, name } = make([{ Attributes: { count: 4, ttl: 99 } }]);
    expect(await db.incrementCounter('p', 'RATE#x', 99)).toBe(4);
    expect(name()).toBe('UpdateCommand');
    expect(input()).toEqual({
      TableName: 'tbl',
      Key: { pk: 'p', sk: 'RATE#x' },
      UpdateExpression: 'ADD #c :one SET #t = :ttl',
      ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': 99 },
      ReturnValues: 'UPDATED_NEW',
    });
  });

  it('incrementCounter falls back to 1 if no attributes come back', async () => {
    const { db } = make([{}]);
    expect(await db.incrementCounter('p', 's', 1)).toBe(1);
  });

  it('bumpItemMemory passes a larger `by` through to ADD', async () => {
    const { db, input } = make();
    await db.bumpItemMemory('p', 'MEM#milk', 'Dairy', 'now', 3);
    expect(input().ExpressionAttributeValues).toEqual({ ':by': 3, ':c': 'Dairy', ':t': 'now' });
  });
});

describe('createDynamoDb queryItems', () => {
  it('sends a key-condition Query for the partition and sk prefix', async () => {
    const { db, input, name } = make([{ Items: [{ pk: 'p', sk: 'A#1' }] }]);
    expect(await db.queryItems('p', 'A#')).toEqual([{ pk: 'p', sk: 'A#1' }]);
    expect(name()).toBe('QueryCommand');
    expect(input()).toEqual({
      TableName: 'tbl',
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': 'p', ':p': 'A#' },
      ExclusiveStartKey: undefined,
    });
  });

  it('follows LastEvaluatedKey across pages and concatenates in order', async () => {
    const k1 = { pk: 'p', sk: 'A#2' };
    const k2 = { pk: 'p', sk: 'A#4' };
    const { db, send, input } = make([
      { Items: [{ pk: 'p', sk: 'A#1' }, k1], LastEvaluatedKey: k1 },
      { Items: [{ pk: 'p', sk: 'A#3' }, k2], LastEvaluatedKey: k2 },
      { Items: [{ pk: 'p', sk: 'A#5' }] },
    ]);
    const got = await db.queryItems('p', 'A#');
    expect(got.map((i) => i.sk)).toEqual(['A#1', 'A#2', 'A#3', 'A#4', 'A#5']);
    expect(send).toHaveBeenCalledTimes(3);
    expect(input(0).ExclusiveStartKey).toBeUndefined();
    expect(input(1).ExclusiveStartKey).toEqual(k1);
    expect(input(2).ExclusiveStartKey).toEqual(k2);
  });

  it('returns [] when a page has no Items', async () => {
    const { db } = make([{}]);
    expect(await db.queryItems('p', 'A#')).toEqual([]);
  });
});

describe('in-memory double semantics that mirror DynamoDB', () => {
  it('putItem drops undefined attributes (top-level and nested)', async () => {
    const db = createMemoryDb();
    await db.putItem({ pk: 'p', sk: 's', a: undefined, b: { c: undefined, d: 1 }, e: [{ f: undefined, g: 2 }] });
    const got = await db.getItem('p', 's');
    expect(got).toEqual({ pk: 'p', sk: 's', b: { d: 1 }, e: [{ g: 2 }] });
    expect('a' in got!).toBe(false);
  });

  it('incrementCounter preserves other attributes and overwrites ttl', async () => {
    const db = createMemoryDb();
    await db.putItem({ pk: 'p', sk: 's', count: 5, ttl: 1, note: 'keep' });
    expect(await db.incrementCounter('p', 's', 2)).toBe(6);
    expect(await db.getItem('p', 's')).toEqual({ pk: 'p', sk: 's', count: 6, ttl: 2, note: 'keep' });
  });

  it('queryItems returns the partition and prefix only, sorted by sk', async () => {
    const db = createMemoryDb();
    for (const sk of ['A#3', 'A#1', 'B#1', 'A#2']) await db.putItem({ pk: 'p', sk });
    await db.putItem({ pk: 'q', sk: 'A#0' });
    expect((await db.queryItems('p', 'A#')).map((i) => i.sk)).toEqual(['A#1', 'A#2', 'A#3']);
  });

  it('conditions: exists / equals / absent / failure maps to ConditionFailedError', async () => {
    const db = createMemoryDb();
    await expect(db.putItem({ pk: 'p', sk: 's' }, { exists: true })).rejects.toBeInstanceOf(ConditionFailedError);
    await db.putItem({ pk: 'p', sk: 's', version: 1 }, { absent: ['pk'] });
    await expect(db.putItem({ pk: 'p', sk: 's' }, { absent: ['pk'] })).rejects.toBeInstanceOf(ConditionFailedError);
    await expect(db.putItem({ pk: 'p', sk: 's' }, { equals: { version: 2 } })).rejects.toBeInstanceOf(ConditionFailedError);
    await db.putItem({ pk: 'p', sk: 's', version: 2 }, { exists: true, equals: { version: 1 } });
  });

  it('deleteItem is a no-op for a missing item', async () => {
    const db = createMemoryDb();
    await expect(db.deleteItem('p', 'nope')).resolves.toBeUndefined();
  });
});

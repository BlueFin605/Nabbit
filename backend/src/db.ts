/**
 * Shared single-table data access for the API Lambda (table `TABLE_NAME`, keys `pk`/`sk`, TTL `ttl`).
 *
 * Handlers depend on the small `Db` interface, never on the AWS SDK directly, so unit tests inject
 * the in-memory double from `db-memory.ts` via `setDb()`. Key layout (see infrastructure/SYSDOC.md):
 *   recipe item   pk=OWNER#{ownerId}  sk=RECIPE#{id}
 * Helpers `ownerPk` / `recipeSk` build keys so every item is scoped to its owner by construction.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

/** A stored item: key attributes plus arbitrary attributes. */
export type Item = { pk: string; sk: string } & Record<string, unknown>;

/** Write precondition (all parts must hold). Evaluated against the existing item, if any. */
export interface Condition {
  /** Require the item to exist. */
  exists?: boolean;
  /** Require these attributes to equal the given values. */
  equals?: Record<string, unknown>;
  /** Require these attributes to be absent. */
  absent?: string[];
}

/** Thrown by `putItem` when its `Condition` fails. */
export class ConditionFailedError extends Error {
  constructor() {
    super('condition_failed');
    this.name = 'ConditionFailedError';
  }
}

export interface Db {
  getItem(pk: string, sk: string): Promise<Item | undefined>;
  /** Create or replace an item; throws `ConditionFailedError` if `condition` fails. */
  putItem(item: Item, condition?: Condition): Promise<void>;
  /** All items in a partition whose sk starts with `skPrefix` (follows pagination). */
  queryItems(pk: string, skPrefix: string): Promise<Item[]>;
}

export const ownerPk = (ownerId: string): string => `OWNER#${ownerId}`;
export const recipeSk = (id: string): string => `RECIPE#${id}`;
export const RECIPE_SK_PREFIX = 'RECIPE#';

/** DynamoDB-backed implementation. `AWS_ENDPOINT_URL` (local dev) is honoured by the SDK itself. */
export function createDynamoDb(tableName = process.env.TABLE_NAME ?? '', client?: DynamoDBDocumentClient): Db {
  const doc =
    client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return {
    async getItem(pk, sk) {
      const res = await doc.send(new GetCommand({ TableName: tableName, Key: { pk, sk } }));
      return res.Item as Item | undefined;
    },
    async putItem(item, condition) {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const parts: string[] = [];
      if (condition?.exists) parts.push('attribute_exists(pk)');
      Object.entries(condition?.equals ?? {}).forEach(([k, v], i) => {
        names[`#e${i}`] = k;
        values[`:e${i}`] = v;
        parts.push(`#e${i} = :e${i}`);
      });
      (condition?.absent ?? []).forEach((k, i) => {
        names[`#a${i}`] = k;
        parts.push(`attribute_not_exists(#a${i})`);
      });
      try {
        await doc.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ...(parts.length
              ? {
                  ConditionExpression: parts.join(' AND '),
                  ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
                  ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
                }
              : {}),
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') throw new ConditionFailedError();
        throw err;
      }
    },
    async queryItems(pk, skPrefix) {
      const items: Item[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const res = await doc.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
            ExpressionAttributeValues: { ':pk': pk, ':p': skPrefix },
            ExclusiveStartKey: start,
          }),
        );
        items.push(...((res.Items ?? []) as Item[]));
        start = res.LastEvaluatedKey;
      } while (start);
      return items;
    },
  };
}

let current: Db | undefined;

/** The process-wide Db (created lazily from env on first use). */
export function getDb(): Db {
  return (current ??= createDynamoDb());
}

/** Test hook: inject a Db (pass undefined to reset to the lazy default). */
export function setDb(db: Db | undefined): void {
  current = db;
}

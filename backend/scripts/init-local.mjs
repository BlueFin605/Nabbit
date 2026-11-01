// Creates the local DynamoDB table (same key schema as the CDK table) and the image bucket
// in LocalStack. Idempotent. Env: AWS_ENDPOINT_URL, TABLE_NAME, IMAGE_BUCKET.
import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const region = process.env.AWS_REGION ?? 'us-east-1';
const tableName = process.env.TABLE_NAME ?? 'nabbit-local-data';
const bucket = process.env.IMAGE_BUCKET ?? 'nabbit-local-images';
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };

const ddb = new DynamoDBClient({ endpoint, region, credentials });
const s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true });

try {
  await ddb.send(new DescribeTableCommand({ TableName: tableName }));
  console.log(`table ${tableName} exists`);
} catch {
  await ddb.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  await ddb.send(
    new UpdateTimeToLiveCommand({ TableName: tableName, TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } }),
  );
  console.log(`table ${tableName} created`);
}

try {
  await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  console.log(`bucket ${bucket} exists`);
} catch {
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`bucket ${bucket} created`);
}

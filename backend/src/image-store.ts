/**
 * Server-side recipe image storage (S3 client, key builder, putter). Kept free of route registration so the
 * import Lambda can store images without also registering the presign route (routes/images.ts).
 */
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ImageContentType } from './import/safe-fetch.js';

export const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

let s3: S3Client | undefined;
export function getS3(): S3Client {
  s3 ??= new S3Client({});
  return s3;
}

/** `{ownerId}/{uuid}.{ext}` - the prefix always comes from the JWT, never the client. */
export function imageKeyFor(ownerId: string, contentType: ImageContentType): string {
  return `${ownerId}/${randomUUID()}.${EXT[contentType]}`;
}

export type ImagePutter = (req: { key: string; contentType: string; bytes: Uint8Array }) => Promise<void>;
const s3Putter: ImagePutter = async (req) => {
  const bucket = process.env.IMAGE_BUCKET;
  if (!bucket) throw new Error('IMAGE_BUCKET is not set');
  await getS3().send(new PutObjectCommand({ Bucket: bucket, Key: req.key, Body: req.bytes, ContentType: req.contentType }));
};
let putter: ImagePutter = s3Putter;
/** Test seam: replace the S3 putter (pass undefined to reset). */
export function setImagePutter(p: ImagePutter | undefined): void {
  putter = p ?? s3Putter;
}

/** Server-side upload (used by the image-import route). Returns the new imageKey. */
export async function putRecipeImage(ownerId: string, contentType: ImageContentType, bytes: Uint8Array): Promise<string> {
  const key = imageKeyFor(ownerId, contentType);
  await putter({ key, contentType, bytes });
  return key;
}

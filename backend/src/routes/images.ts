/**
 * Recipe image upload endpoint (scoped to the caller's ownerId from the JWT):
 *   POST /recipes/images   body { contentType: 'image/jpeg'|'image/png'|'image/webp' }
 *                          -> 200 { imageKey, url, fields, expiresIn }
 *
 * Mechanism: an S3 presigned POST (not PUT), because only POST policies can enforce a
 * `content-length-range` (max 5 MB) as well as the exact Content-Type. The client sends a
 * multipart/form-data POST to `url` with every entry of `fields` first, then the `file` part last.
 * `imageKey` is `{ownerId}/{uuid}.{ext}` - the prefix always comes from the JWT, never the client.
 * Images are read through CloudFront at `IMAGE_BASE_URL/{imageKey}`; the bucket is private.
 * The S3 call is behind `setImageSigner` so unit tests never touch AWS.
 */
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import type { ImageContentType } from '../import/safe-fetch.js';
import { HttpError, route, type RequestCtx } from '../router.js';

import { MAX_IMAGE_BYTES } from '../image-limits.js';
export { MAX_IMAGE_BYTES };
export const UPLOAD_EXPIRES_IN = 300;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export interface SignRequest {
  key: string;
  contentType: string;
  maxBytes: number;
  expiresIn: number;
}
export interface SignedPost {
  url: string;
  fields: Record<string, string>;
}
export type ImageSigner = (req: SignRequest) => Promise<SignedPost>;

let s3: S3Client | undefined;
function getS3(): S3Client {
  s3 ??= new S3Client({});
  return s3;
}
const s3Signer: ImageSigner = async (req) => {
  const bucket = process.env.IMAGE_BUCKET;
  if (!bucket) throw new Error('IMAGE_BUCKET is not set');
  return createPresignedPost(getS3(), {
    Bucket: bucket,
    Key: req.key,
    Conditions: [['content-length-range', 0, req.maxBytes], ['eq', '$Content-Type', req.contentType]],
    Fields: { 'Content-Type': req.contentType },
    Expires: req.expiresIn,
  });
};

let signer: ImageSigner = s3Signer;
/** Test seam: replace the S3 signer. */
export function setImageSigner(s: ImageSigner): void {
  signer = s;
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

async function createUpload({ ownerId, body }: RequestCtx) {
  const contentType = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).contentType : undefined;
  const ext = typeof contentType === 'string' ? EXT[contentType] : undefined;
  if (typeof contentType !== 'string' || ext === undefined) {
    throw new HttpError(400, 'contentType must be image/jpeg, image/png or image/webp');
  }
  const imageKey = `${ownerId}/${randomUUID()}.${ext}`;
  const { url, fields } = await signer({ key: imageKey, contentType, maxBytes: MAX_IMAGE_BYTES, expiresIn: UPLOAD_EXPIRES_IN });
  return { status: 200, body: { imageKey, url, fields, expiresIn: UPLOAD_EXPIRES_IN } };
}

export function registerImageRoutes(): void {
  route('POST', '/recipes/images', createUpload);
}

registerImageRoutes();

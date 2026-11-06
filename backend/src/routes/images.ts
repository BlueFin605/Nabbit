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
import { EXT, getS3 } from '../image-store.js';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { HttpError, route, type RequestCtx } from '../router.js';

import { MAX_IMAGE_BYTES } from '../image-limits.js';
export { MAX_IMAGE_BYTES };
// Re-exported for existing callers; the import Lambda imports ../image-store.js directly (no route side effect).
export { imageKeyFor, putRecipeImage, setImagePutter, type ImagePutter } from '../image-store.js';
export const UPLOAD_EXPIRES_IN = 300;

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

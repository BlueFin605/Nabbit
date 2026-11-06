import { environment } from '../../../environments/environment';

/** URL of a stored recipe image (`${imageBaseUrl}/${imageKey}`); the one place image URLs are built. */
export function imageUrl(imageKey: string): string {
  const base = environment.imageBaseUrl.replace(/\/+$/, '');
  return `${base}/${imageKey.split('/').map(encodeURIComponent).join('/')}`;
}

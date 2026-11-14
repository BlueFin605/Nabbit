import { extractImageCandidates } from './extract-images.js';
import { extractStructured, type StructuredDraft } from './extract-structured.js';
import { stripTrackingParams } from './source-url.js';

export interface StructuredPage {
  /** The page URL with tracking params stripped. */
  sourceUrl: string;
  /** The schema.org extraction (still carrying imageUrl), or undefined when the page has none. */
  structured: StructuredDraft | undefined;
  /** Photo fields as the import route returns them: present only when candidates were found. */
  images: { imageUrl?: string; candidates?: string[] };
}

/** JSON-LD / microdata extraction plus photo candidates for a fetched page; shared by the URL import route and linked-recipe lookup. */
export function extractStructuredPage(page: { url: string; html: string }): StructuredPage {
  const sourceUrl = stripTrackingParams(page.url);
  const structured = extractStructured(page.html, sourceUrl);
  const candidates = extractImageCandidates(page.html, page.url, structured?.imageUrl);
  return { sourceUrl, structured, images: candidates.length ? { imageUrl: candidates[0], candidates } : {} };
}

/** The draft with imageUrl removed (the client picks a photo from the candidates). */
export function withoutImageUrl(structured: StructuredDraft): StructuredDraft {
  const draft = { ...structured };
  delete draft.imageUrl;
  return draft;
}

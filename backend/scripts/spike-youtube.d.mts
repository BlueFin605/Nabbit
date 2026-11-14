export interface CaptionTrack {
  languageCode?: string;
  kind?: string;
  baseUrl?: string;
}
export function extractPlayerResponse(html: string): Record<string, unknown> | undefined;
export function selectCaptionTrack(tracks: CaptionTrack[] | undefined): CaptionTrack | undefined;
export function flattenCaptions(body: string): string;
export function extractDescriptionLinks(description: string): string[];

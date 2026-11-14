/** Recipe links in a YouTube description: filter them, then try each as a schema.org page (never the LLM). */
import type { RecipeDraft } from '@nabbit/recipe-core';
import type { ImportDeps } from '../routes/import.js';
import { extractStructuredPage, withoutImageUrl } from './structured-page.js';

/** Hosts that never hold a recipe: YouTube/Google, social, shops, link shorteners and tip jars. Matched against the lowercase hostname. */
export const SKIP_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)youtube\.com$/,
  /(^|\.)youtu\.be$/,
  /(^|\.)youtube-nocookie\.com$/,
  /(^|\.)google\.[a-z.]+$/,
  /(^|\.)goo\.gl$/,
  /(^|\.)instagram\.com$/,
  /(^|\.)tiktok\.com$/,
  /(^|\.)facebook\.com$/,
  /(^|\.)fb\.me$/,
  /(^|\.)twitter\.com$/,
  /(^|\.)x\.com$/,
  /(^|\.)patreon\.com$/,
  /(^|\.)amazon\.[a-z.]+$/,
  /(^|\.)amzn\.to$/,
  /(^|\.)a\.co$/,
  /(^|\.)bit\.ly$/,
  /(^|\.)linktr\.ee$/,
  /(^|\.)ko-fi\.com$/,
  /(^|\.)paypal\.me$/,
  /(^|\.)myshopify\.com$/,
  /(^|\.)shopify\.com$/,
  /^(shop|store)\./,
];

function isSkippedHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  // IP literals (v4 or bracketed v6) and dotless names are never recipe sites; the safe-fetch guard is the real defence.
  if (host.startsWith('[') || /^\d+(\.\d+){0,3}$/.test(host) || !host.includes('.')) return true;
  return SKIP_HOST_PATTERNS.some((re) => re.test(host));
}

/** Ordered, deduped https links from a description that could plausibly hold a recipe, at most `max`. */
export function candidateRecipeLinks(description: string, max = 3): string[] {
  const links: string[] = [];
  for (const m of description.matchAll(/https:\/\/[^\s<>"']+/g)) {
    const link = m[0].replace(/[.,;:!?)\]]+$/, '');
    let host: string;
    try {
      host = new URL(link).hostname;
    } catch {
      continue;
    }
    if (isSkippedHost(host) || links.includes(link)) continue;
    links.push(link);
    if (links.length >= max) break;
  }
  return links;
}

export interface LinkedRecipe {
  recipe: RecipeDraft;
  /** The page URL the recipe came from (after redirects, tracking params stripped); it is also the draft's sourceUrl. */
  url: string;
  imageUrl?: string;
  candidates?: string[];
}

/** First link whose page holds a schema.org Recipe. Any error or non-structured page moves on; the LLM is never called. */
export async function tryLinkedRecipe(links: string[], deps: Pick<ImportDeps, 'safeFetch'>): Promise<LinkedRecipe | undefined> {
  for (const link of links) {
    try {
      const page = await deps.safeFetch(link);
      if (isSkippedHost(new URL(page.url).hostname)) continue;
      const { sourceUrl, structured, images } = extractStructuredPage(page);
      if (structured?.confidence !== 'structured') continue;
      return { recipe: withoutImageUrl(structured), url: sourceUrl, ...images };
    } catch {
      // next link
    }
  }
  return undefined;
}

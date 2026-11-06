/** Tracking query params removed from a URL before it is kept as a recipe's sourceUrl (mirror of backend/src/import/source-url.ts). */
const TRACKING_PARAMS = new Set(['gclid', 'gad_source', 'gad_campaignid', 'gbraid', 'wbraid', 'fbclid', 'pp']);

const isTracking = (name: string): boolean => {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || n.startsWith('utm_');
};

/** The URL without ad/analytics tracking params. Other params, path and fragment are kept; unparseable input is returned as is. */
export function stripTrackingParams(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    if (![...u.searchParams.keys()].some(isTracking)) return rawUrl;
    for (const k of [...new Set(u.searchParams.keys())]) if (isTracking(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

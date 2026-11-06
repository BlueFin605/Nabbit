/** Tracking query params removed from a URL before it is stored as a recipe's sourceUrl (lower-case exact names plus utm_*). */
const TRACKING_PARAMS = new Set(['gclid', 'gad_source', 'gad_campaignid', 'gbraid', 'wbraid', 'fbclid', 'pp']);

const isTracking = (name: string): boolean => {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || n.startsWith('utm_');
};

/**
 * Pure helper: the URL without ad/analytics tracking params (gclid, gad_*, gbraid, wbraid, fbclid, pp, utm_*).
 * Other params, the path and the fragment are kept. Unparseable input is returned as is. Fetching may still use the original URL.
 */
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

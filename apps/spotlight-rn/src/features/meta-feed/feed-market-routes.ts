/**
 * The pages that belong to the Social feed's market/news sections. When
 * `resolveFeedMarketBlocksEnabled()` is off (production), these routes send the
 * viewer back to the feed instead of rendering.
 */
const FEED_MARKET_ROUTE_ROOTS = ['/meta', '/news', '/calendar', '/set-spotlight'];

/** Where a hidden market page lands instead: the Social feed tab. */
export const FEED_MARKET_FALLBACK_URL = '/social';

/** True for `/meta`, `/meta/group/x`, `/news?kind=video`, `/set-spotlight/sv8`… */
export function isFeedMarketRoutePath(url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  return FEED_MARKET_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

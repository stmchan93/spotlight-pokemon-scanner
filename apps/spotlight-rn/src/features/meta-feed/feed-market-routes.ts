/**
 * The pages behind the Social tab's News and Market Watch. A push notification
 * into one lands on the fallback while `resolveFeedMarketBlocksEnabled()` is off
 * (see `notification-routing`).
 */
const FEED_MARKET_ROUTE_ROOTS = ['/meta', '/news', '/calendar', '/set-spotlight'];

/** Where a hidden market page lands instead: the Social feed tab. */
export const FEED_MARKET_FALLBACK_URL = '/social';

/** True for `/meta`, `/meta/group/x`, `/news?kind=video`, `/set-spotlight/sv8`… */
export function isFeedMarketRoutePath(url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  return FEED_MARKET_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

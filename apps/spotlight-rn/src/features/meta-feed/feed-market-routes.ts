/**
 * The stand-alone market/news pages (meta, news, calendar, set spotlight). News
 * articles also run inline in Social's FOR YOU, and Market Watch lives on the
 * Home profile's MARKET ANALYTICS tab. A push notification into one of these
 * pages lands on the fallback while `resolveFeedMarketBlocksEnabled()` is off
 * (see `notification-routing`).
 */
const FEED_MARKET_ROUTE_ROOTS = ['/meta', '/news', '/calendar', '/set-spotlight'];

/** Where a hidden market page lands instead: Social's FOR YOU, which carries the news. */
export const FEED_MARKET_FALLBACK_URL = '/social';

/** True for `/meta`, `/meta/group/x`, `/news?kind=video`, `/set-spotlight/sv8`… */
export function isFeedMarketRoutePath(url: string): boolean {
  const pathname = url.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  return FEED_MARKET_ROUTE_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

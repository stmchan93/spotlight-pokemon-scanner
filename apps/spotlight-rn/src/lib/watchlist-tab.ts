/**
 * The route contract for the WATCHLIST bottom tab (`/wishlist`, Figma 6775:16938):
 * a page with two top tabs, WATCHLIST and MARKET ANALYTICS.
 *
 * `/wishlist?tab=market` opens it on MARKET ANALYTICS. The route reads `tab`,
 * selects that page, then clears the param so the same link works again.
 * The route keeps its internal `wishlist` name so pushes the backend already
 * sent (`/wishlist`) still land here.
 */
export const WATCHLIST_TAB_PARAM = 'tab';

export const WATCHLIST_PAGE_TABS = ['watchlist', 'market'] as const;

export type WatchlistPageTab = (typeof WATCHLIST_PAGE_TABS)[number];

/** `/wishlist` — the WATCHLIST bottom tab, on its WATCHLIST page. */
export const WATCHLIST_HREF = '/wishlist' as const;

/** `/wishlist?tab=market` — the WATCHLIST bottom tab, on MARKET ANALYTICS. */
export const MARKET_ANALYTICS_HREF = `/wishlist?${WATCHLIST_TAB_PARAM}=market` as const;

/** Validates a raw route param (string, array or absent) into a known page, or null. */
export function parseWatchlistPageTabParam(value: unknown): WatchlistPageTab | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  // `wishlist` is the internal / legacy spelling; users call it Watchlist.
  if (normalized === 'wishlist') {
    return 'watchlist';
  }
  return (WATCHLIST_PAGE_TABS as readonly string[]).includes(normalized)
    ? (normalized as WatchlistPageTab)
    : null;
}

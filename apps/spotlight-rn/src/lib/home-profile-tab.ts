/**
 * The route contract for opening Home (`/`, the owner's profile) on a given
 * profile tab.
 *
 * Watchlist left the bottom bar for a tab of the Home profile (Figma 6642:5964:
 * COLLECTION · MASTER SET · WATCHLIST, plus MARKET ANALYTICS — Social's old
 * Market Watch, owner 2026-11-22). Everything that used to send people to
 * `/wishlist` — notifications, the assistant, old deep links via the
 * `(tabs)/wishlist` redirect — now lands on `/?tab=watchlist`.
 *
 * The Home screen reads `tab` with `useLocalSearchParams`, selects that profile
 * tab, and should then clear it (`router.setParams({ tab: undefined })`) so a
 * later visit to Home does not snap back to it.
 */
export const HOME_PROFILE_TAB_PARAM = 'tab';

export const HOME_PROFILE_TABS = ['collection', 'masterset', 'watchlist', 'market'] as const;

export type HomeProfileTabParam = (typeof HOME_PROFILE_TABS)[number];

/** `/?tab=watchlist` — Home, on its Watchlist tab. */
export const HOME_WATCHLIST_HREF = `/?${HOME_PROFILE_TAB_PARAM}=watchlist` as const;

/** Validates a raw route param (string, array or absent) into a known tab, or null. */
export function parseHomeProfileTabParam(value: unknown): HomeProfileTabParam | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  // `wishlist` is the internal / legacy spelling; users call it Watchlist.
  if (normalized === 'wishlist') {
    return 'watchlist';
  }
  return (HOME_PROFILE_TABS as readonly string[]).includes(normalized)
    ? (normalized as HomeProfileTabParam)
    : null;
}

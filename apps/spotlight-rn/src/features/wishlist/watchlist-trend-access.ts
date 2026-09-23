/**
 * How much of the "since watched" trend the Watchlist shows. The paywall
 * switch: `full` = % and sparkline, `percentOnly` = % without the sparkline,
 * `hidden` = neither. A blurred/locked treatment replaces the hidden parts
 * once the paid tier is designed.
 */
export type WatchlistTrendAccess = 'full' | 'percentOnly' | 'hidden';

export const WATCHLIST_TREND_ACCESS: WatchlistTrendAccess = 'full';

export const SINCE_WATCHED_SUFFIX = 'since watched';

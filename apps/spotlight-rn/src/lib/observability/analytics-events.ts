/**
 * Event names for the product-analytics events that have a stable contract.
 * Only events added or renamed since the 2026-09 cleanup live here; older
 * call sites still pass string literals.
 *
 * Every property sent with these must be non-identifying (enums, counts,
 * ranks, lanes). The privacy scrubber redacts ids/prices/urls anyway — don't
 * rely on it.
 */
export const AnalyticsEvent = {
  // Watchlist (the "wishlist_*" names were retired in favour of these).
  watchlistItemAdded: 'watchlist_item_added',
  watchlistItemRemoved: 'watchlist_item_removed',
  watchlistBulkAdded: 'watchlist_bulk_added',
  watchTargetSet: 'watch_target_set',
  // Watchlist empty state's "Suggest cards to watch" button.
  watchlistSuggestionsRequested: 'watchlist_suggestions_requested',

  // Feed / discovery surfaces.
  metaGroupOpened: 'meta_group_opened',
  metaCalloutTapped: 'meta_callout_tapped',
  hotCardOpened: 'hot_card_opened',
  comingUpEventOpened: 'coming_up_event_opened',
  newsItemOpened: 'news_item_opened',

  // Card page.
  similarCardsShown: 'similar_cards_shown',
  similarCardOpened: 'similar_card_opened',

  // Notifications.
  alertPrefChanged: 'alert_pref_changed',
  pushOpened: 'push_opened',

  // People.
  peopleSearchPerformed: 'people_search_performed',
  peopleProfileOpened: 'people_profile_opened',
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

export type WatchlistItemKind = 'sealed' | 'card';

// watchlist_item_added/removed also carry `has_printing: boolean` — whether the
// watch named a specific printing. Never the printing label or a card id.

// Sealed products carry a backend-minted id prefix
// (`backend/catalog_tools.py` SEALED_CARD_ID_PREFIX); watchlist rows don't carry
// `productKind`, so this is the only signal available there.
const SEALED_CARD_ID_PREFIX = 'tcgp-sealed-';

export function watchlistKindForCardId(cardId: string | null | undefined): WatchlistItemKind {
  return cardId?.startsWith(SEALED_CARD_ID_PREFIX) ? 'sealed' : 'card';
}

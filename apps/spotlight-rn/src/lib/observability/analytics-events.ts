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

  // Feed / discovery surfaces.
  metaGroupOpened: 'meta_group_opened',
  metaCalloutTapped: 'meta_callout_tapped',
  hotCardOpened: 'hot_card_opened',
  comingUpEventOpened: 'coming_up_event_opened',
  newsItemOpened: 'news_item_opened',

  // Card page.
  similarCardsShown: 'similar_cards_shown',
  similarCardOpened: 'similar_card_opened',
  // "Worth grading?" sheet: opened {cardId (scrubbed), game}; result {verdict,
  // summarySource}; ask_ekalight = its Ask Ekalight button.
  gradingAnalysisOpened: 'grading_analysis_opened',
  gradingAnalysisResult: 'grading_analysis_result',
  gradingAnalysisAskEkalight: 'grading_analysis_ask_ekalight',

  // Settings (the gear on Home; replaced the hamburger drawer and its
  // `drawer_opened` / `drawer_item_tapped`). `settings_item_tapped` carries `item`.
  settingsOpened: 'settings_opened',
  settingsItemTapped: 'settings_item_tapped',

  // Collection picker (Home's collection switcher). No collection names or ids.
  // switched carries `is_default_target`, `collection_count`;
  // created carries `collection_count_after`.
  collectionPickerOpened: 'collection_picker_opened',
  collectionSwitched: 'collection_switched',
  collectionCreated: 'collection_created',

  // Collection CSV export. All carry `scope` (all | single) and `source` (settings);
  // succeeded also carries `empty` (nothing to export). tapped fires once the scope is chosen.
  collectionExportTapped: 'collection_export_tapped',
  collectionExportSucceeded: 'collection_export_succeeded',
  collectionExportFailed: 'collection_export_failed',

  // Swipe chain across the bottom tabs. Carries `from_tab`, `to_tab`, `direction` (next | previous).
  tabSwipeNavigated: 'tab_swipe_navigated',

  // Notifications.
  alertPrefChanged: 'alert_pref_changed',
  pushOpened: 'push_opened',

  // People.
  peopleSearchPerformed: 'people_search_performed',
  peopleProfileOpened: 'people_profile_opened',

  // App Store review prompt.
  reviewPromptEligible: 'review_prompt_eligible',
  reviewPromptRequested: 'review_prompt_requested',
  reviewStorePageOpened: 'review_store_page_opened',

  // Booth posts (docs/booth-posts-vendor-spec-2026-10-29.md). Carry `event_id` + `vendor_id`.
  boothClaimed: 'booth_claimed',
  boothCardOpened: 'booth_card_opened',
  boothStatsViewed: 'booth_stats_viewed',
  boothPostCreated: 'booth_post_created',
  boothBannerTapped: 'booth_banner_tapped',
  // Booth stories: `source` = strip | row | card on open; completed = a vendor's last frame played.
  boothStoryOpened: 'booth_story_opened',
  boothStoryCompleted: 'booth_story_completed',

  // Show feeds: every post tagged to a show (event_id), booth or attendee. Carry `event_id`.
  eventFeedViewed: 'event_feed_viewed',
  eventPostCreated: 'event_post_created',

  // Ask Ekalight (docs/ai-chat-contracts-2026-11-17.md). `source` = home | scanner;
  // limit_hit carries `is_guest`; action events carry `type` (the action type).
  assistantOpened: 'assistant_opened',
  assistantQuestionSent: 'assistant_question_sent',
  assistantLimitHit: 'assistant_limit_hit',
  assistantActionConfirmed: 'assistant_action_confirmed',
  assistantActionDismissed: 'assistant_action_dismissed',
  assistantActionUndone: 'assistant_action_undone',
  // UI tap only (`rating`, `reason`); the server's `assistant_feedback` is the count of record.
  assistantFeedbackTapped: 'assistant_feedback_tapped',
  // Composer "+" photo cropped and sent to the scanner (`photo_source`: camera | library).
  assistantPhotoAttached: 'assistant_photo_attached',
  // Search box natural-language search: intent, chip_count, result_count, latency_ms, fell_back, trigger.
  // NEVER the query text.
  smartSearchPerformed: 'smart_search_performed',
  // The "Ask Ekalight" row under a question typed into search.
  smartSearchAskTapped: 'smart_search_ask_tapped',
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

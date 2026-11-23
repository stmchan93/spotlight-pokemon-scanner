import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  FlatList,
  type LayoutChangeEvent,
  Linking,
  Pressable,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  RefreshControl,
  type ScrollView,
  Share,
  StyleSheet,
  type TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { CheckCircle, Trash, Xmark } from 'iconoir-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ALL_COLLECTIONS_ID, CARD_GAMES, DEFAULT_CARD_GAME } from '@spotlight/api-client';
import type {
  CardGame,
  Collection,
  CollectionsSnapshot,
  InventoryCardEntry,
} from '@spotlight/api-client';
import {
  EmptyStatePrompt,
  InlineLoader,
  PageTabs,
  type PageTab,
  SectionHeader,
  StateCard,
  Text,
  Toast,
  useSpotlightTheme,
  radii,
  spacing,
  cardGrid,
} from '@spotlight/design-system';

import {
  PortfolioChartCard,
  portfolioRangeCaption,
  portfolioRangeSummaryAfterWarmup,
  trimPortfolioWarmup,
  type PortfolioChartActivePoint,
} from '@/features/portfolio/components/portfolio-chart-card';
import { PortfolioBalanceHeader } from '@/features/portfolio/components/portfolio-balance-header';
import {
  HIDDEN_VALUE_MASK,
  UNKNOWN_VALUE_MASK,
  formatAbbreviatedCurrency,
  withheldPriceNote,
} from '@/features/portfolio/components/portfolio-formatting';
import { SalePriceEditSheet } from '@/features/portfolio/components/sale-price-edit-sheet';
import { CollectionPickerSheet } from '@/features/portfolio/components/collection-picker-sheet';
import { CollectionSearchRow } from '@/features/portfolio/components/collection-search-row';
import {
  HEADER_BACKDROP_FADE_DISTANCE,
  HOME_HEADER_BAR_HEIGHT,
  HOME_HEADER_ROW_HEIGHT,
  HomeHeader,
} from '@/components/home-header';
import {
  CollectionFilterChipRow,
  type CollectionFilterKey,
  type CollectionSortDirection,
  gameFromFilterKey,
  isDirectionalSortKey,
} from '@/features/portfolio/components/collection-filter-chip-row';
import {
  CollectionGridRow,
  CollectionGridSingleRow,
  chunkCollectionGridRows,
} from '@/features/portfolio/components/collection-masonry-grid';
import { CollectionListRow } from '@/features/portfolio/components/collection-list-view';
import { CardActionsSheet } from '@/features/cards/components/card-actions-sheet';
import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';
import {
  buildEbaySearchUrl,
  buildTcgPlayerCardUrl,
  tcgPlayerProductIdFromCardId,
} from '@/features/cards/marketplace-urls';
import {
  useTabLanding,
  useTabPagerHideBackdrop,
  useTabPagerInnerPosition,
} from '@/components/tab-pager/tab-pager-page-context';
import { innerPageForLanding } from '@/lib/tab-pager';
import {
  AnimatedFlatList,
  AnimatedScrollView,
  CollapsibleTabPager,
  PageSwipeGuard,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import { FocusedStatusBar } from '@/components/focused-status-bar';
import { useAssistantPageContext } from '@/features/assistant/page-context/assistant-page-context';
import { EkalightMark } from '@/components/ekalight-mark';
import { ScanTabIcon } from '@/components/nav-tab-icons';
import {
  LAST_CARD_TO_TAB_BAR_GAP,
  useAutomaticInsetListBottomPadding,
  useFloatingAffordanceBottom,
} from '@/lib/tab-bar-insets';
import { usePortfolioScreenModel } from '@/features/portfolio/hooks/use-portfolio-screen-model';
import { usePortfolioViewMode } from '@/features/portfolio/hooks/use-portfolio-view-mode';
import { usePortfolioSummaryVisibility } from '@/features/portfolio/use-portfolio-summary-visibility';
import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useTabsPage } from '@/contexts/tabs-page-context';
import { useAppServices } from '@/providers/app-providers';
import { AnalyticsEvent, watchlistKindForCardId } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { normalizeSocialLink } from '@/features/profile/social-link';
import { PROFILE_SHEET_OVERLAP, ProfileHeader } from '@/features/profile/components/profile-header';
import { FOR_SALE_TAB_ENABLED } from '@/features/profile/for-sale-tab';
import { getResolvedDisplayName, getUserInitials } from '@/features/auth/auth-models';
import { watchlistCardBasicsFromInventoryEntry } from '@/features/wishlist/watchlist-store';
import { WatchlistPage } from '@/features/wishlist/screens/wishlist-screen';
import { MasterSetPage } from '@/features/portfolio/components/master-set-page';
import { MarketAnalyticsPage } from '@/features/market/screens/market-analytics-page';
import type { HomeProfileTabParam } from '@/lib/home-profile-tab';
import { useAuth } from '@/providers/auth-provider';

const GRID_TEST_ID = 'collection-masonry-grid';

// Empty-collection onboarding copy (Figma 3370:4175). The apostrophe is the
// typographic U+2019 the design uses, not a straight quote.
const COLLECTION_EMPTY_MESSAGE = 'Let’s build your collection';

// Figma nav-glyph size, shared with the bottom tab bar (node 1313:7454).
const SCAN_GLYPH_SIZE = 22;

// Home's profile tabs (Figma 6642:5964 + owner, 2026-11-22). ACTIVITY left for
// Social → YOUR POSTS; MARKET ANALYTICS is Social's old Market Watch, moved
// here. For Sale still renders a gated "Coming soon" behind its flag.
type ProfileTab = 'collection' | 'masterset' | 'watchlist' | 'market' | 'forsale';
const ALL_PROFILE_TABS: readonly PageTab<ProfileTab>[] = [
  { value: 'collection', label: 'Collection' },
  { value: 'masterset', label: 'Master Set' },
  { value: 'watchlist', label: 'Watchlist' },
  { value: 'market', label: 'Market Analytics' },
  { value: 'forsale', label: 'For Sale' },
];
// Tabs that mount on first visit rather than with Home: each one's reads (set
// catalogs, watchlist, market pulse) are paid only once you open it.
const LAZY_PROFILE_TABS: ReadonlySet<ProfileTab> = new Set(['masterset', 'watchlist', 'market']);
// For Sale is hidden until the feature exists — see `FOR_SALE_TAB_ENABLED` for
// why this is a filter rather than a deleted line. Every For Sale render path
// below stays live and type-checked.
const PROFILE_TABS = ALL_PROFILE_TABS.filter(
  (tab) => tab.value !== 'forsale' || FOR_SALE_TAB_ENABLED,
);
// Left→right order the horizontal page swipe walks. Derived from PROFILE_TABS so
// the two can never disagree about which tab is "next".
const PROFILE_TAB_ORDER = PROFILE_TABS.map((tab) => tab.value);

// Press-and-hold duration before a card's actions menu opens — a standard
// long-press (iOS context menus sit around here).
const CARD_LONG_PRESS_MS = 500;

/**
 * Marketplace link for a Collection card, used by the long-press Share action.
 *
 * Same rule as the PDP's "View on" link: raw goes to TCGplayer, graded to eBay
 * SOLD comps. The inventory row carries no TCGplayer product id, so only a
 * TCGplayer-only card (whose id encodes its product) gets the product page;
 * every other raw card falls back to the search.
 *
 * Returns null when the entry has too little to identify it; the caller then
 * shares the plain text it always did.
 */
function buildMarketplaceUrlForEntry(entry: InventoryCardEntry): string | null {
  if (entry.kind === 'graded') {
    return buildEbaySearchUrl({
      cardNumber: entry.cardNumber,
      grade: entry.slabContext?.grade ?? null,
      grader: entry.slabContext?.grader ?? null,
      name: entry.name,
      setName: entry.setName,
      variant: entry.slabContext?.variantName ?? entry.variantName ?? null,
      game: entry.game,
    });
  }
  return buildTcgPlayerCardUrl({
    productId: tcgPlayerProductIdFromCardId(entry.cardId),
    cardNumber: entry.cardNumber,
    condition: entry.conditionLabel ?? entry.conditionCode ?? null,
    name: entry.name,
    printing: entry.variantName ?? null,
    setName: entry.setName,
    game: entry.game,
  });
}

// How long the holdings reads will wait for `listCollections` to say which
// collection they are for. See the scope gate in the screen body.
const COLLECTION_SCOPE_WAIT_MS = 2000;

// Floor between profile re-reads on focus (follower/following/Fame counts,
// cover). Tab-hopping must not turn into a Supabase read per hop.
const PROFILE_REFRESH_MIN_INTERVAL_MS = 30_000;

const isTestEnv = process.env.NODE_ENV === 'test';

// A short "click" the moment a card is selected by long-press (iOS-style
// context-menu feedback). Guarded so tests + missing native modules no-op.
function triggerSelectionHaptic() {
  if (isTestEnv) {
    return;
  }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

// When the collection search gains focus, scroll the search row up to near the
// top of the viewport so the keyboard can't cover it (and the filtered results
// land directly underneath). This small gap keeps it off the very top edge.
const SEARCH_FOCUS_TOP_GAP = 12;

// Figma 2724:1757 — 24px total between the profile tab bar and the Portfolio
// balance. This used to be 8 because the shared header wrapper contributed a
// 16px inter-child gap on top of it; the tab bar now lives in the pinned chrome
// ABOVE the page, so this carries the whole gap on its own.
const SEARCH_TO_CHIPS_GAP = 8;
const TABS_TO_BALANCE_GAP = 24;

type PortfolioScreenProps = {
  onOpenInventoryEntry?: (entry: InventoryCardEntry) => void;
  /**
   * A profile tab the route asked for (`/?tab=watchlist`, see
   * `home-profile-tab.ts`). Selected when it changes, then handed back through
   * `onRequestedProfileTabHandled` so the route can clear its param.
   */
  requestedProfileTab?: HomeProfileTabParam | null;
  onRequestedProfileTabHandled?: () => void;
};

// One virtualized row of the collection list. In list view each entry is its
// own row; in card view a row holds up to two tiles (or a single boxed tile
// when the collection has exactly one card).
type CollectionRow =
  | { kind: 'list'; key: string; entry: InventoryCardEntry; firstInSection: boolean }
  | {
      kind: 'grid';
      key: string;
      rowEntries: InventoryCardEntry[];
      rowIndex: number;
      /** Closes the grid's bottom edge — only the final row carries it. */
      isLastRow: boolean;
    }
  | { kind: 'grid-single'; key: string; entry: InventoryCardEntry }
  /** Heads the cross-collection search results ("In other collections"). */
  | { kind: 'section-header'; key: string; title: string };


function applyInventorySearch(items: InventoryCardEntry[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return items;
  }

  return items.filter((item) => {
    return [
      item.name,
      item.cardNumber,
      item.setName,
      item.conditionLabel,
      item.conditionShortLabel,
      item.variantName,
      item.slabContext?.grader,
      item.slabContext?.grade,
      item.slabContext?.variantName,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalized);
  });
}

/**
 * Display copy of a cross-collection search match. The section reuses the exact
 * row/tile components, and the meta line's `setName` slot is the least invasive
 * place they both render, so the folder name rides there
 * ("#4/102 · Base Set · Binder"). Press handlers must forward the PRISTINE
 * entry (see `crossCollectionOriginals`) so the PDP preview never carries the
 * suffixed set name.
 */
function withCollectionContext(entry: InventoryCardEntry): InventoryCardEntry {
  const label = entry.collectionName?.trim();
  if (!label) {
    return entry;
  }
  return { ...entry, setName: entry.setName ? `${entry.setName} · ${label}` : label };
}

// Parse an ISO timestamp to epoch ms; missing/invalid sort oldest (so they land
// last under a descending "most recent first" sort).
function timestampMs(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

/**
 * The distinct games present in a collection, in `CARD_GAMES` order.
 *
 * An entry with no `game` counts as Pokémon rather than as its own bucket —
 * older cached payloads (and any backend predating multi-game) carry none, and
 * treating those as a separate game would show a two-chip row to a user with a
 * plain Pokémon collection.
 */
export function collectionGames(items: InventoryCardEntry[]): CardGame[] {
  const present = new Set<CardGame>();
  for (const entry of items) {
    present.add(entry.game ?? DEFAULT_CARD_GAME);
  }
  return CARD_GAMES.filter((game) => present.has(game));
}

export function applyCollectionFilter(
  items: InventoryCardEntry[],
  filter: CollectionFilterKey,
  direction: CollectionSortDirection = 'desc',
): InventoryCardEntry[] {
  // PRICE / DATE flip on a second tap; everything else ignores direction.
  const sign = direction === 'asc' ? -1 : 1;
  // Game chips are dynamic (one per game the user actually owns), so they can't
  // be `case` labels. Same undefined-means-Pokémon rule as collectionGames.
  const gameFilter = gameFromFilterKey(filter);
  if (gameFilter) {
    return items.filter((entry) => (entry.game ?? DEFAULT_CARD_GAME) === gameFilter);
  }
  switch (filter) {
    case 'all':
      // Recently added first.
      return [...items].sort((a, b) => timestampMs(b.addedAt) - timestampMs(a.addedAt));
    case 'az':
      return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    case 'price':
      return [...items].sort((a, b) => {
        // Unpriced cards sink to the bottom in either direction.
        if (a.hasMarketPrice !== b.hasMarketPrice) {
          return a.hasMarketPrice ? -1 : 1;
        }
        return sign * ((b.hasMarketPrice ? b.marketPrice : 0) - (a.hasMarketPrice ? a.marketPrice : 0));
      });
    case 'date':
      return [...items].sort((a, b) => sign * (timestampMs(b.addedAt) - timestampMs(a.addedAt)));
    case 'favorites':
      // Recently favorited first (falls back to addedAt until favoritedAt is
      // populated by the backend).
      return items
        .filter((entry) => entry.isFavorite === true)
        .sort((a, b) => (
          timestampMs(b.favoritedAt ?? b.addedAt) - timestampMs(a.favoritedAt ?? a.addedAt)
        ));
    case 'ungraded':
      return items.filter((entry) => entry.kind !== 'graded');
    case 'graded':
      return items.filter((entry) => entry.kind === 'graded');
    case 'sir':
    case 'illustration':
    case 'ultra':
    case 'secret':
    case 'shiny':
      // Server-computed bucket; entries from older cached payloads carry no
      // rarityBucket and simply never match a rarity chip.
      return items.filter((entry) => entry.rarityBucket === filter);
    default:
      return items;
  }
}

export function PortfolioScreen({
  onOpenInventoryEntry = () => {},
  requestedProfileTab = null,
  onRequestedProfileTabHandled,
}: PortfolioScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const auth = useAuth();
  const currentUser = auth.currentUser;
  // Home's profile tab (Collection / Master Set / Watchlist / Market Analytics).
  const [activeProfileTab, setActiveProfileTab] = useState<ProfileTab>('collection');
  // Watchlist's own edit mode: like Collection's, it owns every gesture.
  const [isWatchlistEditing, setIsWatchlistEditing] = useState(false);
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<ProfileTab>>(() => new Set(['collection']));
  if (!visitedTabs.has(activeProfileTab)) {
    setVisitedTabs(new Set([...visitedTabs, activeProfileTab]));
  }
  // `/?tab=…` from the route: select it, then let the route clear the param so
  // a later visit to Home doesn't snap back to it.
  useEffect(() => {
    if (!requestedProfileTab) {
      return;
    }
    if (PROFILE_TAB_ORDER.includes(requestedProfileTab)) {
      setActiveProfileTab(requestedProfileTab);
    }
    onRequestedProfileTabHandled?.();
  }, [onRequestedProfileTabHandled, requestedProfileTab]);
  // Revealed by a drag back from Search: show the NEAR edge, Market Analytics,
  // so the strip reads as one continuous row of pages.
  useTabLanding('index', (edge) => {
    const page = innerPageForLanding(PROFILE_TAB_ORDER, edge);
    if (page) {
      setActiveProfileTab(page);
    }
  });
  // The bottom-tab pager reads this to hand a drag past the last tab to the outer strip.
  useTabPagerInnerPosition({
    count: PROFILE_TAB_ORDER.length,
    index: PROFILE_TAB_ORDER.indexOf(activeProfileTab),
  });
  const profileName = currentUser ? getResolvedDisplayName(currentUser) : 'Portfolio';
  const profileInitials = currentUser ? getUserInitials(currentUser) : 'P';
  const handleSocialLinkPress = useCallback(() => {
    const link = currentUser?.socialLink;
    if (!link) {
      return;
    }
    // Normalised here too, not only on save: profiles written before this
    // validation existed still hold raw text, and this is the call that would
    // silently no-op on it.
    const url = normalizeSocialLink(link);
    if (!url) {
      return;
    }
    void Linking.openURL(url).catch(() => {});
  }, [currentUser?.socialLink]);

  // Owner's own followers / following lists. Reuse the shared `/u/[handle]`
  // follow-list routes with the signed-in user's id (and handle when claimed),
  // so the owner and public-profile paths render the same screen.
  const ownFollowListParams = useMemo(() => {
    const ownerId = currentUser?.id;
    if (!ownerId) {
      return null;
    }
    const handleSlug = currentUser?.handle?.trim();
    return {
      handle: handleSlug && handleSlug.length > 0 ? handleSlug : ownerId,
      userId: ownerId,
      // The follow list is titled with the profile's name (Figma 5753:13043).
      title: getResolvedDisplayName(currentUser),
    };
  }, [currentUser]);

  const handleOpenFollowers = useCallback(() => {
    if (ownFollowListParams) {
      router.push({ pathname: '/u/[handle]/followers', params: ownFollowListParams });
    }
  }, [ownFollowListParams, router]);

  const handleOpenFollowing = useCallback(() => {
    if (ownFollowListParams) {
      router.push({ pathname: '/u/[handle]/following', params: ownFollowListParams });
    }
  }, [ownFollowListParams, router]);
  // The floating top bar rests just below the safe-area inset and hovers OVER
  // the profile cover hero, which is full-bleed to the very top (under the
  // status bar) — so the scroll content starts at 0.
  // NOTE: no guest on-mount redirect here. This screen is mounted *alongside*
  // the scanner in the tabs pager (both pages live at once), so a redirect would
  // fire the instant a guest lands on the scanner and bounce them to login.
  // Guests are kept out of Collection by the pager lock + the gated Home tab
  // instead.
  const {
    spotlightRepository,
    refreshData,
    removeOptimisticInventoryEntries,
    activeCollectionID,
    setActiveCollectionID,
    isActiveCollectionRestored,
    watchlistStore,
    insightsGame,
  } = useAppServices();
  const [collectionsSnapshot, setCollectionsSnapshot] = useState<CollectionsSnapshot | null>(null);
  const [isLoadingCollections, setIsLoadingCollections] = useState(false);
  const [hasReadCollections, setHasReadCollections] = useState(false);

  /*
    THE HOLDINGS READS MUST NOT START UNDER A SCOPE WE ARE ABOUT TO CHANGE.

    `ALL_COLLECTIONS_ID` is now a readout, not a scope, so on a cold start the
    active collection resolves to a real one as soon as the collections read
    lands. But a scope change BLANKS the model and refetches
    (`use-portfolio-screen-model.ts`), so starting under the placeholder buys a
    3-5s dashboard we immediately throw away — a second expensive fetch and a
    skeleton flash on every launch.

    So the aggregate counts as resolved only once we know there is nothing to
    resolve it to. Three escape hatches, because the cost of a wrong answer here
    is a Collection tab that never paints:
      - a FAILED collections read still sets `hasReadCollections` (it is set in
        `finally`), which falls through to the aggregate;
      - a SLOW or hung one is capped by the timeout below — one wasted dashboard
        fetch is a far better outcome than a blank screen;
      - the persisted choice may still be in flight, and it wins over the
        default — so the gate waits on it too.
  */
  const isCollectionScopeResolved = activeCollectionID !== ALL_COLLECTIONS_ID
    || (isActiveCollectionRestored
      && hasReadCollections
      && (collectionsSnapshot?.collections.length ?? 0) === 0);

  // Cap the wait. `listCollections` is a small query and normally beats this by
  // an order of magnitude, but first paint must never be hostage to it.
  useEffect(() => {
    const timer = setTimeout(() => setHasReadCollections(true), COLLECTION_SCOPE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const model = usePortfolioScreenModel({ isCollectionScopeResolved, refetchOnForeground: true });
  const [isCollectionPickerVisible, setIsCollectionPickerVisible] = useState(false);
  const [collectionPendingDelete, setCollectionPendingDelete] = useState<Collection | null>(null);
  // An action to run only AFTER the collection picker's modal has fully gone —
  // same rule as the card actions menu below: a second overFullScreen modal
  // cannot present while the first is still up.
  const pendingPickerDismissActionRef = useRef<(() => void) | null>(null);
  const [isDeletingCollection, setIsDeletingCollection] = useState(false);
  const [collectionDeleteError, setCollectionDeleteError] = useState<string | null>(null);
  const { isHidden: isSummaryHidden, toggle: toggleSummaryHidden } = usePortfolioSummaryVisibility();
  const { viewMode, toggleViewMode } = usePortfolioViewMode();
  const { activePage, setCollectionEditing } = useTabsPage();
  const handleTabBarScroll = useTabBarScrollHandler();
  const [activeChartPoint, setActiveChartPoint] = useState<PortfolioChartActivePoint | null>(null);
  const [isChartScrubbing, setIsChartScrubbing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<CollectionFilterKey>('all');
  const [sortDirection, setSortDirection] = useState<CollectionSortDirection>('desc');
  // A second tap on the active PRICE / DATE chip flips its direction; picking
  // any chip fresh starts descending (highest / newest first).
  const handleFilterChange = useCallback((next: CollectionFilterKey) => {
    if (next === activeFilter && isDirectionalSortKey(next)) {
      setSortDirection((current) => (current === 'desc' ? 'asc' : 'desc'));
      return;
    }
    setActiveFilter(next);
    setSortDirection('desc');
  }, [activeFilter]);
  // Bulk multi-select "edit mode" (Figma). While active the bottom tab bar +
  // horizontal page swipe are locked (via setCollectionEditing) and tapping a
  // card toggles selection instead of opening it.
  const [editMode, setEditMode] = useState(false);
  // The edit bar sits above the tab bar; the blur under the bar would reach it.
  useTabPagerHideBackdrop(editMode);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Ids removed in this session optimistically: the screen reads the visible
  // list from the model's local dashboard (which the shared-cache removal can't
  // mutate directly), so we filter these out for instant disappearance until
  // the background refetch lands a fresh dashboard without them.
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());
  // Long-press card actions menu (Figma 1696:8708): the entry whose menu is
  // open, plus the entry pending single-delete confirmation.
  const [actionMenuEntry, setActionMenuEntry] = useState<InventoryCardEntry | null>(null);
  // An action to run only AFTER the actions menu's native modal has fully
  // dismissed — used by Share, since presenting the native share sheet while the
  // modal is still tearing down freezes the screen. Fired from <CardActionsSheet
  // onDismiss>.
  const pendingDismissActionRef = useRef<(() => void) | null>(null);
  // Transient feedback for the actions-menu Wishlist toggle. The Collection rows
  // carry no favorite affordance of their own, so without this the action was
  // literally invisible: a successful toggle looked identical to a write that
  // failed, which is exactly how "tapping Wishlist does nothing" reads.
  const [wishlistToast, setWishlistToast] = useState<string | null>(null);
  const [singleDeleteEntry, setSingleDeleteEntry] = useState<InventoryCardEntry | null>(null);
  const [isSingleDeleting, setIsSingleDeleting] = useState(false);
  // One scroller per page tab. The pager keeps their vertical offsets in step
  // so a horizontal swipe can never reveal a page whose header sits somewhere
  // else; `scrollRef` (Collection) is also the one the scroll-to-top FAB and
  // the search-focus scroll drive, since it is the only long list.
  const scrollRef = useRef<FlatList<CollectionRow>>(null);
  const forSaleScrollRef = useRef<ScrollView>(null);
  const masterSetScrollRef = useRef<CollapsibleScrollTarget>(null);
  const watchlistScrollRef = useRef<CollapsibleScrollTarget>(null);
  const marketScrollRef = useRef<CollapsibleScrollTarget>(null);
  const pageScrollRefs = useMemo<
    Partial<Record<ProfileTab, { readonly current: CollapsibleScrollTarget | null }>>
  >(
    () => ({
      collection: scrollRef,
      forsale: forSaleScrollRef,
      masterset: masterSetScrollRef,
      watchlist: watchlistScrollRef,
      market: marketScrollRef,
    }),
    [],
  );
  // Height of the pinned chrome (profile header + tab bar), captured from the
  // page props so `handleSearchFocus` can convert a layout y inside the page's
  // own header into a content offset.
  const chromePaddingRef = useRef(0);
  // Y offset of the search row within the page header chrome, captured on
  // layout so focusing the field can scroll it into a keyboard-safe position.
  const searchRowYRef = useRef(0);
  // The collection search input, so the top-bar search bubble can scroll the
  // row into view and drop the keyboard open on it.
  const searchInputRef = useRef<TextInput>(null);

  // LIST PADDING: the last card rests 16pt above the tab bar's top edge. The
  // grid's own 4pt closing band counts toward the 16. These lists run
  // `contentInsetAdjustmentBehavior="automatic"`, so UIKit's own bottom inset is
  // netted out (see `useAutomaticInsetListBottomPadding`).
  const bottomNavClearance = useAutomaticInsetListBottomPadding(
    LAST_CARD_TO_TAB_BAR_GAP - (viewMode === 'grid' ? cardGrid.gap : 0),
  );
  const wishlistToastBottom = useFloatingAffordanceBottom(theme.spacing.lg);

  const shouldShowInitialError = !model.hasLoadedDashboard
    && !model.hasLoadedInventory
    && !model.isLoading
    && model.loadError !== null;

  const summary = model.dashboard.summary;
  const baseInventory = model.dashboard.inventoryItems;
  // Holdings the server left out of the total (stale / untrusted price).
  const excludedNote = useMemo(() => withheldPriceNote(baseInventory), [baseInventory]);

  // Price history is young, so 3M / 1Y clamp to its first day and read as
  // broken. Say what the window really is, in the header's scrub-date slot.
  const selectedRangePoints = model.dashboard.ranges[model.selectedRange]?.portfolio;
  // The chart skips the warm-up days, so the caption and change must too.
  const rangeCaption = useMemo(
    () => portfolioRangeCaption(model.selectedRange, trimPortfolioWarmup(selectedRangePoints ?? [])),
    [model.selectedRange, selectedRangePoints],
  );
  const selectedRangeSummary = useMemo(
    () => portfolioRangeSummaryAfterWarmup(selectedRangePoints ?? [], model.selectedRangeSummary),
    [model.selectedRangeSummary, selectedRangePoints],
  );

  // Abbreviated total on the collection summary line (Figma 2749:4753). It
  // honours the balance-visibility toggle — otherwise hiding the big balance
  // would leak the same number one row further down.

  // The pager writes its scroll offset here; this screen only READS it, and
  // hands it to `HomeHeader` raw. It still drives the header collapse and the
  // backdrop fade — the bar's own controls (pill included) are static.
  // Seeded at the iOS rest offset (`-insets.top`, see `pageTopOffset`) so the
  // first frame, before the pager seeds it, doesn't read as "already scrolled".
  const pagerScrollY = useRef(
    new Animated.Value(Platform.OS === 'ios' ? -insets.top : 0),
  ).current;

  /*
    IS THIS TOTAL A REAL NUMBER YET?

    Not the same question as "has the dashboard endpoint answered". The screen
    also runs off an inventory-only fallback total, which is a real number with
    `hasLoadedDashboard` still false — masking that would blank a total we
    genuinely have. So: loaded, or backed by inventory we hold.

    The window this exists for is a collection switch, which drops the
    dashboard to an empty one on purpose (the previous collection's balance
    under the new name is worse than nothing). An empty dashboard's value is 0,
    and 0 printed for 5-10s reads as a portfolio that just vanished — the
    422k → 0 → 424k flash. An empty collection really is $0, so "not known yet"
    has to be its own state rather than inferred from the number.
  */
  const isTotalKnown = model.hasLoadedDashboard
    /*
      The inventory-only fallback still counts — but NOT while the real total is
      on its way. Inventory lands in ~1s and the dashboard behind it, so a cold
      open printed the mask, then the fallback's estimate, then the authoritative
      total: three different headline numbers in a couple of seconds, with the
      rolling digits scrambling between the last two (user, 2026-09-11: "it shows
      like - or 0 or some other value outside of my 424k and then flickers").

      The fallback exists for the case where the dashboard is NOT coming — an
      unreachable backend, where an inventory-derived total beats a permanent
      dash. That case is exactly `!isLoadingDashboard`.
    */
    || (model.dashboard.inventoryItems.length > 0 && !model.isLoadingDashboard);

  const collectionTotalLabel = isSummaryHidden
    ? HIDDEN_VALUE_MASK
    : isTotalKnown
      ? formatAbbreviatedCurrency(summary.currentValue)
      : UNKNOWN_VALUE_MASK;

  // Name shown on the picker. Falls back to "All Collections" for the aggregate,
  // and to the plain label until the collections read lands.
  const activeCollectionName = useMemo(() => {
    const collections = collectionsSnapshot?.collections ?? [];
    if (activeCollectionID === ALL_COLLECTIONS_ID) {
      // With a single collection the aggregate IS that collection, so name it —
      // "All Collections" only earns its place once there is more than one
      // (Figma 3356:2371 rests on "Main Collection").
      return collections.length === 1 ? collections[0].name : 'All Collections';
    }
    const match = collections.find((collection) => collection.id === activeCollectionID);
    return match?.name ?? 'Main Collection';
  }, [activeCollectionID, collectionsSnapshot]);
  // Floating Ekalight bubble: which collection (and game chip) is on screen (read at tap time).
  useAssistantPageContext(() => ({
    label: `Your collection · ${activeCollectionName}`,
    params: { collection: activeCollectionName },
    game: gameFromFilterKey(activeFilter) ?? insightsGame,
  }));

  // Values inside the picker honour the balance-visibility toggle, for the same
  // reason the summary line does — otherwise hiding the balance leaks it here.
  const formatCollectionValue = useCallback(
    (value: number) => (isSummaryHidden ? HIDDEN_VALUE_MASK : formatAbbreviatedCurrency(value)),
    [isSummaryHidden],
  );

  const loadCollections = useCallback(async () => {
    setIsLoadingCollections(true);
    try {
      const snapshot = await spotlightRepository.listCollections();
      setCollectionsSnapshot(snapshot);
      return snapshot;
    } catch {
      // The picker can still switch between what it already knows about; the
      // next open retries.
      return null;
    } finally {
      setIsLoadingCollections(false);
      // Settled either way. Failure has to count: the scope gate above waits on
      // this, and a null snapshot alone cannot tell "still reading" from
      // "read and got nothing".
      setHasReadCollections(true);
    }
  }, [spotlightRepository]);

  // Read the collections once. Two jobs: the picker label is right before it is
  // opened, and the reconcile effect below has the list it needs to turn the
  // aggregate placeholder into a real scope.
  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  /*
    ───────────────────────────────────────────────────────────────────────────
    A COLLECTION THAT NO LONGER EXISTS MUST NOT KEEP SCOPING EVERY READ.
    ───────────────────────────────────────────────────────────────────────────
    The active collection id is restored from disk on launch and was never
    checked against the server's list. Delete that collection — on another
    device, or before a reinstall restored the old value — and every holdings
    read is scoped to an id the backend matches nothing for. It answers 200 with
    zero rows, which is not an error, so the screen showed an empty collection.

    Sticky, too: the id is persisted, so it survived every relaunch, and the
    picker label falls back to "Main Collection" for an unknown id, so nothing
    on screen said which collection you were even looking at. The only way out
    was to open the picker and tap another row.

    This is the top suspect for the "everything was gone" report, and it is the
    only one of that report's causes that would persist rather than heal.

    Waits for a non-null snapshot on purpose: a FAILED collections read leaves
    `collectionsSnapshot` null, and resetting the scope on that would throw away
    a perfectly good selection every time the network hiccuped.
  */
  useEffect(() => {
    const collections = collectionsSnapshot?.collections;
    if (!collections || collections.length === 0) {
      return;
    }
    if (
      activeCollectionID !== ALL_COLLECTIONS_ID
      && collections.some((collection) => collection.id === activeCollectionID)
    ) {
      return;
    }
    // The aggregate means "not resolved yet", and the persisted choice may still
    // be in flight — resolving ahead of it would replace the collection the user
    // actually picked with the default on every cold start.
    if (activeCollectionID === ALL_COLLECTIONS_ID && !isActiveCollectionRestored) {
      return;
    }
    // The aggregate is a readout, not a scope: "all" (the pre-migration
    // default) and a deleted id both resolve to a real collection — the
    // server's default when it still exists, else the first.
    const fallback =
      collections.find(
        (collection) => collection.id === collectionsSnapshot?.defaultCollectionID,
      ) ?? collections[0];
    setActiveCollectionID(fallback.id);
  }, [activeCollectionID, collectionsSnapshot, isActiveCollectionRestored, setActiveCollectionID]);

  const handleOpenCollectionPicker = useCallback(() => {
    setIsCollectionPickerVisible(true);
    void loadCollections();
  }, [loadCollections]);

  const handleRenameCollection = useCallback(
    async (collectionID: string, name: string) => {
      await spotlightRepository.updateCollection({ collectionID, name });
      // Reflect it immediately so the picker label and row don't lag the rename.
      setCollectionsSnapshot((current) =>
        current
          ? {
              ...current,
              collections: current.collections.map((entry) =>
                entry.id === collectionID ? { ...entry, name } : entry,
              ),
            }
          : current,
      );
      void loadCollections();
    },
    [loadCollections, spotlightRepository],
  );

  const handleToggleCollectionHidden = useCallback(
    (collection: Collection) => {
      const nextHidden = !collection.hidden;
      // Optimistic: the eye should flip under the finger, not after a round trip.
      setCollectionsSnapshot((current) =>
        current
          ? {
              ...current,
              collections: current.collections.map((entry) =>
                entry.id === collection.id ? { ...entry, hidden: nextHidden } : entry,
              ),
            }
          : current,
      );
      void (async () => {
        try {
          await spotlightRepository.updateCollection({
            collectionID: collection.id,
            hidden: nextHidden,
          });
          // Hiding changes the un-scoped totals, so the tab has to re-read.
          refreshData();
        } catch {
          // Put the eye back rather than leaving the row lying about its state.
          setCollectionsSnapshot((current) =>
            current
              ? {
                  ...current,
                  collections: current.collections.map((entry) =>
                    entry.id === collection.id ? { ...entry, hidden: collection.hidden } : entry,
                  ),
                }
              : current,
          );
        }
        void loadCollections();
      })();
    },
    [loadCollections, refreshData, spotlightRepository],
  );

  /**
   * Trash on a picker row. The confirm is its own bottom sheet, and a bottom
   * sheet is an `overFullScreen` modal: presenting it while the picker's modal
   * is still up collides at the view-controller layer on iOS, so the confirm
   * never appears — the delete silently did nothing. Close the picker and let
   * its dismissal open the confirm, exactly as `handleMenuDelete` does for the
   * card actions menu.
   */
  const handleRequestDeleteCollection = useCallback((collection: Collection) => {
    setCollectionDeleteError(null);
    pendingPickerDismissActionRef.current = () => setCollectionPendingDelete(collection);
    setIsCollectionPickerVisible(false);
  }, []);

  const handleCollectionPickerDismissed = useCallback(() => {
    const run = pendingPickerDismissActionRef.current;
    pendingPickerDismissActionRef.current = null;
    run?.();
  }, []);

  const handleConfirmDeleteCollection = useCallback(() => {
    const target = collectionPendingDelete;
    if (!target) {
      return;
    }
    setIsDeletingCollection(true);
    void (async () => {
      try {
        await spotlightRepository.deleteCollection(target.id);
        setCollectionPendingDelete(null);
        // If the deleted one was on screen, move to another real collection —
        // the aggregate is not a scope. The reconcile effect covers any gap.
        if (activeCollectionID === target.id) {
          const remaining = collectionsSnapshot?.collections.find(
            (collection) => collection.id !== target.id,
          );
          setActiveCollectionID(remaining?.id ?? ALL_COLLECTIONS_ID);
        }
        refreshData();
        void loadCollections();
      } catch {
        setCollectionDeleteError('Could not delete that collection. Try again.');
      } finally {
        setIsDeletingCollection(false);
      }
    })();
  }, [
    activeCollectionID,
    collectionPendingDelete,
    collectionsSnapshot,
    loadCollections,
    refreshData,
    setActiveCollectionID,
    spotlightRepository,
  ]);

  const handleCreateCollection = useCallback(
    async (name: string) => {
      const created = await spotlightRepository.createCollection(name);
      // Merge it in before switching. Without this the picker label falls back to
      // the previous collection's name until the re-read lands, so the tab would
      // briefly claim you are looking at "Main Collection" right after naming
      // something else.
      setCollectionsSnapshot((current) =>
        current
          ? { ...current, collections: [...current.collections, created] }
          : {
              collections: [created],
              defaultCollectionID: created.id,
              all: { cardCount: 0, totalValue: 0 },
            },
      );
      // Switch to it immediately: the whole point of naming a collection is to
      // start filling it, and it is empty, so the Collection tab lands on the
      // "Let's build your collection" state (Figma 3370:3771).
      setActiveCollectionID(created.id);
      void loadCollections();
    },
    [loadCollections, setActiveCollectionID, spotlightRepository],
  );

  // Which games this collection spans. Derived from the UNFILTERED collection —
  // filtering to One Piece must not then hide the chip that got you there.
  const availableGames = useMemo<CardGame[]>(
    () => collectionGames(baseInventory),
    [baseInventory],
  );
  // A game chip can stop being offered while it is selected (delete the last
  // One Piece card, switch to a single-game collection). Fall back to 'all'
  // here rather than in an effect, so there is never a frame where an invisible
  // chip is silently filtering the list down to nothing.
  const effectiveFilter = useMemo<CollectionFilterKey>(() => {
    const game = gameFromFilterKey(activeFilter);
    if (game && !(availableGames.length > 1 && availableGames.includes(game))) {
      return 'all';
    }
    return activeFilter;
  }, [activeFilter, availableGames]);

  const visibleInventory = useMemo(() => {
    const present = removedIds.size > 0
      ? baseInventory.filter((entry) => !removedIds.has(entry.id))
      : baseInventory;
    const filtered = applyCollectionFilter(present, effectiveFilter, sortDirection);
    return applyInventorySearch(filtered, model.searchQuery);
  }, [baseInventory, effectiveFilter, model.searchQuery, removedIds, sortDirection]);

  // ── Cross-collection search ────────────────────────────────────────────────
  // Searching with more than one collection also surfaces matches from the
  // OTHER folders, under their folder names. The unscoped entries are fetched
  // lazily, on the first search of a screen session; the model re-nulls its
  // cache whenever the scoped inventory refetches, which re-arms this effect.
  const hasMultipleCollections = (collectionsSnapshot?.collections.length ?? 0) > 1;
  const isSearching = model.searchQuery.trim().length > 0;
  const { allInventoryEntries, ensureAllInventoryLoaded } = model;
  useEffect(() => {
    if (isSearching && hasMultipleCollections && allInventoryEntries === null) {
      void ensureAllInventoryLoaded();
    }
  }, [allInventoryEntries, ensureAllInventoryLoaded, hasMultipleCollections, isSearching]);

  // Same pipeline as the active list. Entries the unscoped read cannot
  // attribute to a folder (no collectionId — an older server) are left out
  // rather than risked as duplicates of active rows; the id check covers a
  // server that tags entries but disagrees with the client about scope.
  const crossCollectionMatches = useMemo(() => {
    if (!isSearching || !hasMultipleCollections || !allInventoryEntries) {
      return [];
    }
    const activeIds = new Set(baseInventory.map((entry) => entry.id));
    const others = allInventoryEntries.filter((entry) =>
      entry.collectionId != null
      && entry.collectionId !== activeCollectionID
      && !activeIds.has(entry.id)
      && !removedIds.has(entry.id));
    const filtered = applyCollectionFilter(others, effectiveFilter, sortDirection);
    return applyInventorySearch(filtered, model.searchQuery);
  }, [
    activeCollectionID,
    allInventoryEntries,
    baseInventory,
    effectiveFilter,
    hasMultipleCollections,
    isSearching,
    model.searchQuery,
    removedIds,
    sortDirection,
  ]);

  // The section renders display COPIES (folder name in the meta line); anything
  // that leaves the row — PDP open, actions menu — goes back through this map
  // to the pristine entry.
  const crossCollectionOriginals = useMemo(
    () => new Map(crossCollectionMatches.map((entry) => [entry.id, entry] as const)),
    [crossCollectionMatches],
  );

  // The header's counts and cover come from `currentUser`, which is read once at
  // sign-in (under a launch timeout that can lose). Re-read it when this page is
  // actually in front — the tab focused AND the pager on Portfolio — throttled.
  // Guests have no profile row.
  const lastProfileRefreshAtRef = useRef(0);
  const isGuest = auth.isGuest;
  const refreshCurrentUser = auth.refreshCurrentUser;
  const isPortfolioPageActive = activePage === 'portfolio';
  useFocusEffect(
    useCallback(() => {
      if (isGuest || !isPortfolioPageActive) {
        return;
      }
      const now = Date.now();
      if (now - lastProfileRefreshAtRef.current < PROFILE_REFRESH_MIN_INTERVAL_MS) {
        return;
      }
      lastProfileRefreshAtRef.current = now;
      void refreshCurrentUser();
    }, [isGuest, isPortfolioPageActive, refreshCurrentUser]),
  );


  /*
    NO UNREAD COUNT HERE ANY MORE. This screen used to draw the bell, so it read
    `useUnreadNotificationCount()` for its badge; the profile toolbar
    (3670:47454) spends both trailing slots on edit and share, so there is no
    bell on this screen to badge. Home still calls the hook and still shows the
    count — the hook itself is untouched.
  */

  // Mirror edit mode into the tabs pager so it hides the bottom tab bar + locks
  // the horizontal swipe, and always release the lock on unmount.
  useEffect(() => {
    setCollectionEditing(editMode || isWatchlistEditing);
  }, [editMode, isWatchlistEditing, setCollectionEditing]);

  useEffect(() => () => {
    setCollectionEditing(false);
  }, [setCollectionEditing]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const allVisibleSelected = visibleInventory.length > 0
    && visibleInventory.every((entry) => selectedIds.has(entry.id));

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds(allVisibleSelected
      ? new Set()
      : new Set(visibleInventory.map((entry) => entry.id)));
  }, [allVisibleSelected, visibleInventory]);

  const handleExitSelect = useCallback(() => {
    setEditMode(false);
    setSelectedIds(new Set());
    setDeleteError(null);
  }, []);

  const selectedCount = selectedIds.size;
  const deleteMessage = `You're about to delete ${selectedCount} item${selectedCount === 1 ? '' : 's'} `
    + "from your Portfolio. This can't be undone, and your Portfolio value and Insights will be recalculated.";

  const handleConfirmBulkDelete = useCallback(() => {
    if (selectedIds.size === 0 || isDeleting) {
      return;
    }
    const ids = [...selectedIds];
    setIsDeleting(true);
    setDeleteError(null);
    spotlightRepository
      .deletePortfolioEntriesBulk({ deckEntryIDs: ids })
      .then((result) => {
        const deletedIds = result.deletedDeckEntryIDs.length > 0 ? result.deletedDeckEntryIDs : ids;
        // Drop the rows everywhere: the shared caches (other consumers + a
        // future model re-init) and this screen's visible list, then reconcile
        // against the server with a refetch.
        removeOptimisticInventoryEntries(deletedIds);
        setRemovedIds((prev) => {
          const next = new Set(prev);
          deletedIds.forEach((id) => next.add(id));
          return next;
        });
        setDeleteConfirmOpen(false);
        setEditMode(false);
        setSelectedIds(new Set());
        refreshData();
      })
      .catch(() => {
        setDeleteError('Could not delete these items right now.');
      })
      .finally(() => {
        setIsDeleting(false);
      });
  }, [isDeleting, refreshData, removeOptimisticInventoryEntries, selectedIds, spotlightRepository]);

  // The Collection page runs `contentInsetAdjustmentBehavior="automatic"`, so it
  // RESTS at `-insets.top` rather than at 0 — the same origin the pager is given
  // as `contentInsetTop` below. Negative, and iOS-only, to match that prop.
  // The "Back to top" FAB that consumed this was removed 2026-09-10 (user
  // request); the Collection list now feeds the bottom-bar handler directly.
  const pageTopOffset = Platform.OS === 'ios' ? -insets.top : 0;
  const handleScroll = handleTabBarScroll;

  const handlePressEntry = useCallback(
    (entry: InventoryCardEntry) => {
      if (editMode) {
        toggleSelected(entry.id);
        return;
      }
      onOpenInventoryEntry(crossCollectionOriginals.get(entry.id) ?? entry);
    },
    [crossCollectionOriginals, editMode, onOpenInventoryEntry, toggleSelected],
  );

  // Press-and-hold a card → a "click" haptic + the actions menu (skipped during
  // multi-select edit mode, where a tap toggles selection instead).
  // The id multi-select tracks for the held card (the grid's, not the cross-collection original's).
  const heldEntryIdRef = useRef<string | null>(null);
  const handleLongPressEntry = useCallback(
    (entry: InventoryCardEntry) => {
      if (editMode) {
        return;
      }
      triggerSelectionHaptic();
      heldEntryIdRef.current = entry.id;
      setActionMenuEntry(crossCollectionOriginals.get(entry.id) ?? entry);
    },
    [crossCollectionOriginals, editMode],
  );

  // "Select" in the hold menu: the only way into multi-select since the
  // Select/Done toggle left the search row (Aug 2026).
  const handleMenuSelect = useCallback(() => {
    const id = heldEntryIdRef.current;
    setActionMenuEntry(null);
    if (!id) {
      return;
    }
    setSelectedIds(new Set([id]));
    setEditMode(true);
  }, []);

  const closeActionMenu = useCallback(() => setActionMenuEntry(null), []);

  const handleMenuEdit = useCallback(() => {
    const entry = actionMenuEntry;
    setActionMenuEntry(null);
    if (entry) {
      onOpenInventoryEntry(entry);
    }
  }, [actionMenuEntry, onOpenInventoryEntry]);

  const handleMenuShare = useCallback(() => {
    const entry = actionMenuEntry;
    if (!entry) {
      setActionMenuEntry(null);
      return;
    }
    const message = [entry.name, entry.cardNumber, entry.setName]
      .map((part) => (part ?? '').trim())
      .filter(Boolean)
      .join(' · ');
    // A marketplace link, not just the card's name. `listingUrl` is set on
    // almost nothing, so a share was three words of text with no way to look the
    // card up. Built the same way the PDP builds its "View on" link, and split
    // by lane for the same reason: a TCGplayer search cannot express "PSA 10",
    // so a graded card goes to its eBay sold comps instead.
    const url = entry.listingUrl ?? buildMarketplaceUrlForEntry(entry) ?? undefined;
    // Present the native share sheet only AFTER the actions modal's view
    // controller has fully dismissed — presenting UIActivityViewController while
    // the RN modal is still tearing down freezes the screen. Queue it and let
    // <CardActionsSheet onDismiss> fire it (the deterministic dismissal signal);
    // closing the menu triggers that dismissal.
    pendingDismissActionRef.current = () => {
      void Share.share(url ? { message, url } : { message }).catch(() => undefined);
    };
    setActionMenuEntry(null);
  }, [actionMenuEntry]);

  const handleActionMenuDismissed = useCallback(() => {
    const run = pendingDismissActionRef.current;
    pendingDismissActionRef.current = null;
    run?.();
  }, []);

  // Wishlist ("favorite" internally — see the wishlist naming rule) writes to the
  // same owner-scoped card_favorites store the Wishlist tab reads, and the
  // refreshData() bump is what re-fires that tab's load. The write used to end in
  // `.catch(() => undefined)`, so a 401/404/timeout produced no error, no retry,
  // and no visible change anywhere — indistinguishable from success. Surface both
  // outcomes, and take the *server's* answer for the message rather than the row's
  // local isFavorite, so a stale row can't mislabel what actually happened.
  const handleMenuWishlist = useCallback(() => {
    const entry = actionMenuEntry;
    setActionMenuEntry(null);
    if (!entry) {
      return;
    }
    const nextIsFavorite = !entry.isFavorite;
    // Watch the printing this copy is (slabs keep theirs on the slab context).
    const variant = (entry.variantName ?? entry.slabContext?.variantName ?? '').trim() || null;
    void spotlightRepository
      .setCardFavorite(entry.cardId, nextIsFavorite, { variant })
      .then((record) => {
        const savedIsFavorite = record?.isFavorite ?? nextIsFavorite;
        capturePostHogEvent(
          savedIsFavorite ? AnalyticsEvent.watchlistItemAdded : AnalyticsEvent.watchlistItemRemoved,
          {
            source: 'collection_menu',
            kind: watchlistKindForCardId(entry.cardId),
            has_printing: variant != null,
          },
        );
        setWishlistToast(savedIsFavorite ? 'Added to Watchlist' : 'Removed from Watchlist');
        watchlistStore.applyWatchWrite(
          { ...record, isFavorite: savedIsFavorite, watchVariant: record?.watchVariant ?? variant },
          watchlistCardBasicsFromInventoryEntry(entry),
        );
        refreshData();
      })
      .catch(() => {
        setWishlistToast(
          nextIsFavorite
            ? "Couldn't add that card to your Watchlist. Please try again."
            : "Couldn't remove that card from your Watchlist. Please try again.",
        );
      });
  }, [actionMenuEntry, refreshData, spotlightRepository, watchlistStore]);

  // Delete from the menu: queue the confirm sheet on the actions sheet's
  // deterministic dismissal (same pattern as Share) instead of a timed guess.
  // A fresh RN modal can't present while another is still up; onDismiss is the
  // reliable "the actions modal is fully gone" signal, so opening the confirm
  // sheet there avoids the two-overFullScreen-modal collision that froze the app.
  const handleMenuDelete = useCallback(() => {
    const entry = actionMenuEntry;
    if (!entry) {
      setActionMenuEntry(null);
      return;
    }
    pendingDismissActionRef.current = () => setSingleDeleteEntry(entry);
    setActionMenuEntry(null);
  }, [actionMenuEntry]);

  const handleConfirmSingleDelete = useCallback(() => {
    const entry = singleDeleteEntry;
    if (!entry || isSingleDeleting) {
      return;
    }
    setIsSingleDeleting(true);
    spotlightRepository
      .deletePortfolioEntry({ deckEntryID: entry.id })
      .then(() => {
        removeOptimisticInventoryEntries([entry.id]);
        setRemovedIds((prev) => {
          const next = new Set(prev);
          next.add(entry.id);
          return next;
        });
        setSingleDeleteEntry(null);
        refreshData();
      })
      .catch(() => undefined)
      .finally(() => setIsSingleDeleting(false));
  }, [isSingleDeleting, refreshData, removeOptimisticInventoryEntries, singleDeleteEntry, spotlightRepository]);

  const handleSearchRowLayout = useCallback((event: LayoutChangeEvent) => {
    searchRowYRef.current = event.nativeEvent.layout.y;
  }, []);

  // The search row lives inside the Collection page's own list header, which
  // starts below the pinned chrome — so its content offset is that chrome's
  // height plus the row's measured y within the page header.
  const handleSearchFocus = useCallback(() => {
    const offset = Math.max(
      chromePaddingRef.current + searchRowYRef.current - SEARCH_FOCUS_TOP_GAP,
      0,
    );
    scrollRef.current?.scrollToOffset({ offset, animated: true });
  }, []);

  // The horizontal page-tab swipe stands down while the collection filter field
  // has focus — the keyboard is up and the user is typing, not paging. Read from
  // the input itself rather than a mirrored flag: `CollectionSearchRow` forwards
  // `onFocus` but no `onBlur`, so there would be no reliable moment to clear one.
  const isSearchFieldFocused = useCallback(
    () => searchInputRef.current?.isFocused() === true,
    [],
  );

  const handleEditProfilePress = useCallback(() => {
    router.push('/edit-profile' as never);
  }, [router]);

  // The gear (Figma 6642:6202): Settings replaced the hamburger drawer.
  const handleOpenSettings = useCallback(() => {
    router.push('/settings' as never);
  }, [router]);

  // Empty-collection "Scan to add" chip.
  //
  // This pushed `{ pathname: '/', params: { page: 'scanner' } }` — the retired
  // TopTabsPager's addressing, where a `page` param chose which of two mounted
  // slots to show. With native tabs `/` IS the Collection tab and the param is
  // inert, so the button navigated to the screen you were already on and looked
  // dead. Scan is its own route now.
  const handleScanToAddPress = useCallback(() => {
    router.push('/scan' as never);
  }, [router]);

  // The whole screen is one virtualized FlatList: the balance/chart/search/
  // filter chrome rides along as the list header, and the collection renders
  // row-by-row (one card per row in list view, two tiles per ruled row in card
  // view) so large collections stay smooth without a "View More" gate.
  const listData = useMemo<CollectionRow[]>(() => {
    if (shouldShowInitialError) {
      return [];
    }
    const rows: CollectionRow[] = [];
    // Grid row indexes run across BOTH sections — they key the per-row testIDs,
    // which would otherwise collide.
    let gridRowCount = 0;
    const appendEntries = (entries: InventoryCardEntry[], keyPrefix: string, allowSingle: boolean) => {
      if (viewMode === 'list') {
        entries.forEach((entry, index) => {
          rows.push({
            kind: 'list',
            key: `${keyPrefix}${entry.id}`,
            entry,
            firstInSection: index === 0,
          });
        });
        return;
      }
      if (allowSingle && entries.length === 1) {
        rows.push({ kind: 'grid-single', key: `${keyPrefix}${entries[0].id}`, entry: entries[0] });
        return;
      }
      const gridRows = chunkCollectionGridRows(entries);
      gridRows.forEach((rowEntries, index) => {
        rows.push({
          kind: 'grid',
          key: rowEntries[0] ? `${keyPrefix}${rowEntries[0].id}` : `${keyPrefix}grid-row-${gridRowCount}`,
          rowEntries,
          rowIndex: gridRowCount,
          isLastRow: index === gridRows.length - 1,
        });
        gridRowCount += 1;
      });
    };
    appendEntries(visibleInventory, '', true);
    if (crossCollectionMatches.length > 0) {
      rows.push({
        kind: 'section-header',
        key: 'cross-collection-header',
        title: 'In other collections',
      });
      // No lone-tile treatment here: a single match still reads as part of a
      // ruled results list, not as a boxed showcase.
      appendEntries(crossCollectionMatches.map(withCollectionContext), 'cross-', false);
    }
    return rows;
  }, [crossCollectionMatches, shouldShowInitialError, viewMode, visibleInventory]);

  const renderItem = useCallback(
    ({ item }: { item: CollectionRow }) => {
      if (item.kind === 'section-header') {
        return (
          <View style={styles.crossSectionHeader}>
            <SectionHeader testID="collection-cross-collection-header" title={item.title} />
          </View>
        );
      }
      if (item.kind === 'list') {
        return (
          <CollectionListRow
            delayLongPress={CARD_LONG_PRESS_MS}
            entry={item.entry}
            firstInSection={item.firstInSection}
            onLongPress={handleLongPressEntry}
            onPress={handlePressEntry}
            selectable={editMode}
            selected={editMode && selectedIds.has(item.entry.id)}
          />
        );
      }
      if (item.kind === 'grid-single') {
        return (
          <CollectionGridSingleRow
            delayLongPress={CARD_LONG_PRESS_MS}
            entry={item.entry}
            onLongPressEntry={handleLongPressEntry}
            onPressEntry={handlePressEntry}
            editMode={editMode}
            selectedIds={selectedIds}
            testID={GRID_TEST_ID}
          />
        );
      }
      return (
        <CollectionGridRow
          delayLongPress={CARD_LONG_PRESS_MS}
          isLastRow={item.isLastRow}
          onLongPressEntry={handleLongPressEntry}
          onPressEntry={handlePressEntry}
          rowEntries={item.rowEntries}
          rowIndex={item.rowIndex}
          editMode={editMode}
          selectedIds={selectedIds}
          testID={GRID_TEST_ID}
        />
      );
    },
    [
      editMode,
      handleLongPressEntry,
      handlePressEntry,
      selectedIds,
    ],
  );

  /*
    The profile toolbar (Figma 6642:5964): ONE gear bubble on the right, which
    opens Settings — the hamburger drawer's replacement. Same `HomeHeader`
    Social draws, same geometry; only the trailing control differs.

    Search, edit and share left this bar in the 2026-11-22 redesign: Search is
    a bottom tab, Edit profile is the avatar tap (and a Settings row), and Ask
    Ekalight is the app-wide floating bubble that owns the top-left corner.
  */
  // Mirrors the header's contrast flip (white-over-cover vs dark-when-pinned)
  // onto the STATUS BAR: Figma 4134:49776 shows white time/battery over the
  // cover. Owned here because the header computes the flip but the screen owns
  // the <StatusBar>.
  const [isBarOverCover, setIsBarOverCover] = useState(true);
  // Height of the profile block (cover included). The backdrop stays clear while
  // the cover is under the bar and finishes fading exactly as the sheet's top
  // edge (cover bottom minus the overlap) reaches the bar's bottom edge.
  const [profileBlockHeight, setProfileBlockHeight] = useState(0);
  const handleProfileBlockLayout = useCallback((event: LayoutChangeEvent) => {
    setProfileBlockHeight(event.nativeEvent.layout.height);
  }, []);
  const backdropFadeStart = Math.max(
    profileBlockHeight -
      PROFILE_SHEET_OVERLAP -
      (insets.top + HOME_HEADER_BAR_HEIGHT) -
      HEADER_BACKDROP_FADE_DISTANCE,
    0,
  );
  const homeHeader = (
    <HomeHeader
      onOverCoverChange={setIsBarOverCover}
      trailing={{
        kind: 'profile',
        onOpenSettings: handleOpenSettings,
      }}
      floating
      /*
        `pinnedBackdrop` IS ON, and this was reversed once — read before
        removing it again.

        It was dropped because the opaque strip between the menu button and the
        trailing ones read as "a weird white bar" next to Home, which floats.
        That judgement was made on an empty-ish account, side by side, with
        nothing scrolled under it. A TestFlight tester on a real collection
        reported the opposite and much louder: with cards and filter chips
        sliding through the gap, the whole top of the screen reads as broken.

        The bar is transparent from y=0 down to `insets.top` + 48, and the
        pinned tab bar starts exactly there — so this backdrop and the tab
        bar's own `gray0` together cover the full strip. It fades in with
        scroll (opacity 0 at rest), so the floating look survives at the top of
        the page, which is what the original call was protecting.

        A backdrop on the tab bar alone was the other option this file used to
        recommend. It does not work: the tab bar lives inside the pager's
        chrome layer, which TRANSLATES with scroll, so a plate extended upward
        from it paints over the profile block at rest.
      */
      pinnedBackdrop
      backdropFadeStart={backdropFadeStart}
      // Every page runs `contentInsetAdjustmentBehavior="automatic"` and so
      // rests at `-insets.top` on iOS; `pagerScrollY` carries that ABSOLUTE
      // offset. Without this anchor the pill sat fully open for the first
      // safe-area inset of every scroll. Same number `pageTopOffset` and the
      // pager's `contentInsetTop` use.
      scrollRestOffset={pageTopOffset}
      scrollY={pagerScrollY}
      testID="portfolio-header"
    />
  );

  // ── The PINNED chrome ──────────────────────────────────────────────────────
  // Profile block + tab bar are rendered ONCE, above all three pages. The
  // profile block still scrolls away (the pager translates it up with the active
  // page's offset); the tab bar stops at the top and pins. Both need an opaque
  // background — page content scrolls UNDER them.
  const pagerHeader = (
    <View
      onLayout={handleProfileBlockLayout}
      style={[styles.pinnedBlock, { backgroundColor: theme.colors.gray0 }]}
    >
      <ProfileHeader
        avatarUrl={currentUser?.avatarURL}
        bio={currentUser?.bio}
        // Without this your cover shows on Edit Profile and on your PUBLIC
        // profile, but not on your own Portfolio — the one place you look first.
        coverUrl={currentUser?.coverURL}
        displayName={profileName}
        // Figma 6642:5964: the handle and the link, no name line under them.
        showDisplayName={false}
        followerCount={currentUser?.followerCount}
        followingCount={currentUser?.followingCount}
        handle={currentUser?.handle}
        initials={profileInitials}
        isVerified={currentUser?.isVerified}
        onAddBioPress={handleEditProfilePress}
        // Your own avatar opens Edit profile (the bar's edit pencil is gone).
        onAvatarPress={handleEditProfilePress}
        onFollowersPress={handleOpenFollowers}
        onFollowingPress={handleOpenFollowing}
        onSocialLinkPress={handleSocialLinkPress}
        reputation={currentUser?.reputation}
        socialLink={currentUser?.socialLink}
        testID="portfolio-header-title"
      />
    </View>
  );

  // Focus-gated: this screen stays MOUNTED while the user is on another tab, and
  // an un-gated <StatusBar> would keep setting the style from off-screen — which
  // is exactly what stole the scanner's white bar. See `FocusedStatusBar`.
  const statusBar = <FocusedStatusBar style={isBarOverCover ? 'light' : 'dark'} />;

  const pagerTabBar = (
    // paddingTop 16 = the designed gap above the labels, OPAQUE so nothing
    // slides through it pinned. The rounded top corners live HERE (Figma
    // 4157:74399): at rest the bar is pulled 16 up over the cover's bottom
    // edge (pinnedBlock's negative margin), so the corners notch into the
    // cover; pinned they sit white-on-white under the toolbar backdrop.
    <View
      style={{
        backgroundColor: theme.colors.gray0,
        borderCurve: 'continuous',
        // Figma 6542:18158: 16pt top corners, labels 24 below the sheet edge.
        borderTopLeftRadius: radii.lg,
        borderTopRightRadius: radii.lg,
        paddingTop: spacing.lg,
      }}
    >
      {/* Four tabs outgrow 393pt, so the rail scrolls (and keeps the active
          tab in view); a drag on it scrolls the rail, never the pages. */}
      <PageSwipeGuard>
        <PageTabs
          onChange={setActiveProfileTab}
          scrollable
          tabs={PROFILE_TABS}
          testID="portfolio-profile-tabs"
          uppercase
          value={activeProfileTab}
          variant="underline"
        />
      </PageSwipeGuard>
    </View>
  );

  // ── The Collection page's OWN header ───────────────────────────────────────
  // Balance, chart, stale hint, search row and filter chips used to be siblings
  // of the profile block in one shared list header. They belong to Collection
  // only, so they move into that page and scroll under the pinned tab bar.
  const collectionChrome = (
    <View style={styles.chrome}>
      {shouldShowInitialError ? (
        <View style={{ paddingHorizontal: theme.layout.pageGutter, paddingTop: TABS_TO_BALANCE_GAP }}>
          <StateCard
            actionLabel="Retry"
            actionTestID="collection-retry"
            message={model.loadError || 'Please try again once your backend is reachable.'}
            onActionPress={() => { void model.refresh(); }}
            testID="collection-error"
            title="Could not load your backend data"
            variant="field"
          />
        </View>
      ) : (
        <>
          <View style={{ marginTop: TABS_TO_BALANCE_GAP }}>
            <PortfolioBalanceHeader
              label={activeCollectionName}
              summary={summary}
              rangeSummary={selectedRangeSummary}
              rangeCaption={rangeCaption}
              activeChartPoint={isChartScrubbing ? activeChartPoint : null}
              isSummaryHidden={isSummaryHidden}
              isValueKnown={isTotalKnown}
              excludedNote={excludedNote}
              onToggleHidden={toggleSummaryHidden}
            />
          </View>

          <View style={styles.chartWrap}>
            <PortfolioChartCard
              chartMode="portfolio"
              dashboard={model.dashboard}
              isLoading={(model.isLoadingDashboard && !model.hasLoadedDashboard) || model.isLoadingSelectedRange}
              onActivePointChange={setActiveChartPoint}
              onRangeChange={model.setSelectedRange}
              onScrubLockChange={setIsChartScrubbing}
              selectedRange={model.selectedRange}
            />
          </View>

          {model.loadError || model.isDashboardStale ? (
            <Text
              style={[
                theme.typography.captionMedium,
                styles.staleHint,
                { color: theme.colors.gray500 },
              ]}
              testID="portfolio-stale-hint"
            >
              Your backend data is loading…
            </Text>
          ) : null}

          {/* The search row is the filter field + the view toggle only. The
              "Search Cards" magnifier that used to sit here went with the
              top-bar search bubble (Search is a bottom tab now), and the
              Select / Done edit-mode toggle was removed alongside it. Edit mode
              itself is still wired below — it just has no entry point on this
              row right now. */}
          {/* Figma 5938:21808: 8 from the search to the filter chips, not chrome's 16. */}
          <View onLayout={handleSearchRowLayout} style={styles.searchRowWrap}>
            <CollectionSearchRow
              collectionName={activeCollectionName}
              inputRef={searchInputRef}
              onChangeQuery={model.setSearchQuery}
              onFocus={handleSearchFocus}
              onPressCollection={handleOpenCollectionPicker}
              onToggleViewMode={toggleViewMode}
              query={model.searchQuery}
              totalValueLabel={collectionTotalLabel}
              viewMode={viewMode}
            />
          </View>

          {/* The chips scroll horizontally, so without this guard the page swipe
              (a capture-phase ancestor, and therefore asked first) would page the
              tabs instead of scrolling to the rarity chips. */}
          <PageSwipeGuard>
            <CollectionFilterChipRow
              activeFilter={effectiveFilter}
              games={availableGames}
              onFilterChange={handleFilterChange}
              sortDirection={sortDirection}
            />
          </PageSwipeGuard>
        </>
      )}
    </View>
  );


  // Truly-empty collection (no cards at all) reads differently from an active
  // filter/search that just matched nothing. A filter miss is a RESULT, so it
  // keeps the bordered StateCard; a brand-new collection is an INVITATION, so
  // it gets the Figma onboarding prompt (3370:4175): the Ekalight mark, one
  // encouraging line, and a soft chip straight into the scanner.
  /*
    ───────────────────────────────────────────────────────────────────────────
    "STILL LOADING" MUST NOT LOOK LIKE "YOU HAVE NOTHING".
    ───────────────────────────────────────────────────────────────────────────
    This is why a transient empty read was reported as "EVERYTHING was gone".
    The predicate below only ever distinguished a filter miss from a brand-new
    collection, so a load still in flight — or one that failed while a cached
    dashboard kept `shouldShowInitialError` false — rendered the onboarding
    "Let's build your collection / Scan to add" prompt. To someone with 300
    cards, being shown the new-user invitation IS the report.

    Hence the `InlineLoader` while the first read is still in flight.
  */
  const isCollectionStillLoading = model.isLoading && !model.hasLoadedInventory;
  const listEmpty = shouldShowInitialError ? null : isCollectionStillLoading ? (
    <InlineLoader label="Loading your collection" testID="collection-loading" />
  ) : (
    <View
      style={[
        { paddingHorizontal: theme.layout.pageGutter },
        /*
          Nothing here stretches. The prompt used to `flexGrow` into the leftover
          space and centre itself, back when every page was floored at
          `screenHeight + collapseDistance` and the alternative was a thousand
          points of dead white below it. An empty list drops that floor outright
          now (`styles.emptyListContent`), so the growth had nothing left to
          justify it and was itself the dead space.
        */
      ]}
    >
      {model.hasInventoryEntries ? (
        <StateCard
          message="Add cards from the scanner or tap the + button to start your portfolio."
          style={styles.emptyStateCard}
          title="No cards match this filter"
        />
      ) : (
        <EmptyStatePrompt
          actionIcon={<ScanTabIcon color={theme.colors.gray900} size={SCAN_GLYPH_SIZE} />}
          actionLabel="Scan to add"
          actionTestID="collection-empty-scan-to-add"
          illustration={<EkalightMark />}
          message={COLLECTION_EMPTY_MESSAGE}
          onActionPress={handleScanToAddPress}
          style={styles.emptyPrompt}
          testID="collection-empty-prompt"
        />
      )}
    </View>
  );

  // One scroller per page tab. Each keeps its OWN virtualization — the heavy
  // Collection list is exactly as virtualized as it was when it was the whole
  // screen. `page` carries the padding, the animated scroll handler and the
  // refresh-spinner offset the pager needs; spread it, never wrap `page.onScroll`
  // in another function or it silently loses the native driver.
  const renderProfilePage = (tab: ProfileTab, page: CollapsiblePageProps) => {
    // Captured for `handleSearchFocus`, which has to turn a layout y inside the
    // Collection page header into an absolute content offset.
    chromePaddingRef.current = page.contentContainerStyle.paddingTop;

    // Not yet opened: an empty page until first visit (see LAZY_PROFILE_TABS).
    if (LAZY_PROFILE_TABS.has(tab) && !visitedTabs.has(tab)) {
      return <View style={styles.listWrap} testID={`portfolio-${tab}-placeholder`} />;
    }

    if (tab === 'masterset') {
      return (
        <MasterSetPage
          bottomPadding={bottomNavClearance}
          enabled
          page={page}
          scrollRef={masterSetScrollRef}
        />
      );
    }

    if (tab === 'watchlist') {
      return (
        <WatchlistPage
          isActive={isPortfolioPageActive && activeProfileTab === 'watchlist'}
          onEditModeChange={setIsWatchlistEditing}
          page={page}
          scrollRef={watchlistScrollRef}
        />
      );
    }

    if (tab === 'market') {
      return (
        <MarketAnalyticsPage
          page={page}
          scrollRef={marketScrollRef}
          testID="portfolio-market-page"
        />
      );
    }

    if (tab === 'forsale') {
      return (
        <AnimatedScrollView
          ref={forSaleScrollRef}
          // Same inset behaviour as the Collection list, and NOT optional: the
          // pager reserves chrome height less `contentInsetTop` on the
          // assumption every page is inset by UIKit. A page left on RN's
          // `never` default gets no such inset, so its content came up a whole
          // status bar and hid under the tab bar.
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={page.contentContainerStyle}
          onScroll={page.onScroll}
          scrollEventThrottle={page.scrollEventThrottle}
          // RN clamps a NEGATIVE scrollTo target to 0 unless this is set
          // (RCTScrollViewComponentView.mm), and it clamps against
          // `contentInset` — which is empty here, because
          // `contentInsetAdjustmentBehavior="automatic"` puts the safe area
          // in `adjustedContentInset` instead. Without it every "go to the
          // top" the pager or the FAB performs lands `insets.top` short.
          scrollToOverflowEnabled={page.scrollToOverflowEnabled}
          testID="portfolio-forsale-page"
        >
          <View
            style={{
              paddingHorizontal: theme.layout.pageGutter,
              paddingTop: TABS_TO_BALANCE_GAP,
            }}
          >
            <StateCard
              message="For Sale is coming soon."
              title="Coming soon"
              variant="field"
            />
          </View>
        </AnimatedScrollView>
      );
    }


    return (
      <View
        /*
          THIS IS WHAT MAKES THE NATIVE TAB BAR MINIMIZE ON SCROLL. Not a
          micro-optimisation — removing it silently kills the behaviour again.

          Both UIKit and react-native-screens locate a screen's "content scroll
          view" by walking `subviews[0]` down from the tab screen
          (`RNSScrollViewFinder.findScrollViewInFirstDescendantChainFrom`,
          documented there as mirroring UIKit). Anything that leaves a childless
          UIView at index 0 ends that walk.

          React Native's view flattening does exactly that here.
          `ViewShadowNode::initialize` (ReactCommon/.../view/ViewShadowNode.cpp)
          computes two separate traits:
            - formsView          <- true for this View, because `testId` is set
            - formsStackingContext <- FALSE, because `flex: 1` alone qualifies
              for none of the conditions
          and `sliceChildShadowNodeViewPairs.cpp` then mounts a node whose
          children are "flattened" as a real but EMPTY view, re-parenting its
          children as its own next SIBLINGS, which ends the walk at an empty view
          and leaves UIKit with no scroll view to track.

          `collapsable={false}` forces formsStackingContext, so the FlatList
          stays inside this view and index 0 leads to it at every level. This is
          the fix the react-native-screens maintainer gives in
          software-mansion/react-native-screens#3954 (closed as answered), for
          this exact symptom.

          The pager renders the PAGES before the pinned chrome for the same
          reason — see the note in `page-tab-pager.tsx`. Collection is page 0, so
          it is the list the walk reaches; the other two tabs do not drive the
          minimize, which is the one thing this restructure gives up.
        */
        collapsable={false}
        style={styles.listWrap}
        testID={
          shouldShowInitialError
            ? undefined
            : viewMode === 'grid'
              ? 'collection-masonry-grid'
              : 'collection-list-view'
        }
      >
        <AnimatedFlatList
          ref={scrollRef}
          // Keyboard handling for the in-header search field: inset the scroll
          // content by the keyboard height so a small (e.g. single-result)
          // filtered list can still scroll clear of the keyboard instead of
          // staying trapped half-behind it — this also keeps the focus-scroll
          // offset valid so the list no longer snaps/jumps as results shrink
          // while typing. Swipe-to-dismiss + persist-taps let you reach a result
          // (open the card) without an extra tap to drop the keyboard first.
          //
          // ...but ONLY while this list is the thing the keyboard belongs to.
          // The prop is a raw keyboard-frame subscription on the native scroll
          // view (RCTScrollViewComponentView._keyboardWillChangeFrame): ANY
          // keyboard rewrites this list's contentInset and scrolls it, with no
          // check for which window raised it. The collection picker's "New
          // Collection" field is in a modal on top, so its keyboard was
          // reaching down here and moving a list the user could not even see —
          // which is how naming a collection and backing out left the page
          // stuck. While a sheet is up the search field cannot be focused, so
          // there is nothing to adjust for.
          automaticallyAdjustKeyboardInsets={!isCollectionPickerVisible}
          // Keeps this list on UIKit's `automatic` inset behaviour instead of
          // React Native's `never` default, which is what lets the content sit
          // correctly under the native tab bar.
          //
          // This prop is NOT what makes the tab bar minimize on scroll — the
          // `collapsable={false}` on the wrapper above is. Keep both: they share
          // a cause but not a mechanism. react-native-screens also wants to set
          // this value itself (`TabsScreen`'s
          // `overrideScrollViewContentInsetAdjustmentBehavior` defaults to true,
          // and `RNSBottomTabsScreenComponentView.mountChildComponentView` runs
          // `RNSScrollViewHelper` over the first-descendant chain) — but that
          // helper walks the SAME `subviews[0]` chain, so while the chain was
          // broken it never reached this list and this prop was carrying the
          // inset behaviour on its own.
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            page.contentContainerStyle,
            { paddingBottom: bottomNavClearance },
            // An empty page drops the pager's screenful floor (the old "ton of
            // whitespace" below "Scan to add") but keeps the bottom-nav
            // clearance: a tall header can push the prompt down to the nav.
            listData.length === 0 ? styles.emptyListContent : null,
          ]}
          data={listData}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={listEmpty}
          ListHeaderComponent={collectionChrome}
          onScroll={page.onScroll}
          refreshControl={(
            <RefreshControl
              onRefresh={model.refresh}
              // Drop the spinner below the pinned chrome rather than letting it
              // spin up behind the profile header / tab bar.
              progressViewOffset={page.progressViewOffset}
              refreshing={model.isRefreshing}
              testID="portfolio-refresh-control"
              tintColor={theme.colors.gray400}
            />
          )}
          renderItem={renderItem}
          scrollEnabled={!isChartScrubbing}
          scrollEventThrottle={page.scrollEventThrottle}
          // RN clamps a NEGATIVE scrollTo target to 0 unless this is set
          // (RCTScrollViewComponentView.mm), and it clamps against
          // `contentInset` — which is empty here, because
          // `contentInsetAdjustmentBehavior="automatic"` puts the safe area
          // in `adjustedContentInset` instead. Without it every "go to the
          // top" the pager or the FAB performs lands `insets.top` short.
          scrollToOverflowEnabled={page.scrollToOverflowEnabled}
          testID="portfolio-scroll-view"
        />
      </View>
    );
  };

  // Only the Collection page drives the bottom-bar minimize signal: it is the
  // only page long enough for it to mean anything.
  const handlePageScroll = (tab: ProfileTab, event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (tab === 'collection') {
      handleScroll(event);
    }
    // The SLIDE is native-driven off `pagerScrollY` inside the bar; this only
    // flips the pill's tap target off once it has gone. Runs on every page so
    // the state cannot go stale when a swipe lands on a tab parked further
    // down, and the equality guard means React re-renders on the crossing, not
    // per frame.
    // TRAVEL from the page's own top, not the raw offset — every page rests at
    // `pageTopOffset` (negative on iOS), so comparing the raw value disarmed
    // the pill a whole safe-area inset after the bar had faded it out.
    // NOTHING TO DISARM ANY MORE. The header's pill is static, so it is always
    // visible and always tappable; `pointerEvents` only ever needed switching
    // off because opacity alone left an invisible pill catching taps over the
    // collection.
  };

  return (
    <>
    {/* Overrides the route's static style: white glyphs over the cover, dark
        once the bar pins — mirrors the header's own contrast flip. */}
    {statusBar}
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
    >
      {/*
        Collapsing profile header, pinned tab bar, drag-following pages beneath.
        It is the FIRST child of the SafeAreaView, so the `subviews[0]` walk
        still reaches the Collection list.
      */}
      <CollapsibleTabPager
        // Every page runs `contentInsetAdjustmentBehavior="automatic"`, so UIKit
        // already insets it by the top safe area; without this the chrome
        // padding reserved the same status bar again and opened a second one of
        // white between the tab bar and the Portfolio balance.
        contentInsetTop={Platform.OS === 'ios' ? insets.top : 0}
        disabled={editMode || isWatchlistEditing}
        header={pagerHeader}
        // Fades the profile block across exactly the strip it would park in, so
        // scrolled down you see only the bubbles and the tabs. Same expression as
        // `pinnedTopInset` below by necessity — keep the two together.
        headerFadeDistance={insets.top + HOME_HEADER_ROW_HEIGHT}
        onChange={setActiveProfileTab}
        onPageScroll={handlePageScroll}
        order={PROFILE_TAB_ORDER}
        pageRefs={pageScrollRefs}
        // Park the tab bar under the floating bubbles instead of at y=0, where
        // the profile tabs ended up drawn behind the clock.
        // FLUSH against the toolbar, no +16: the toolbar backdrop only covers
        // its own height, so a parked gap is a see-through strip with cards
        // sliding through it. The designed 16 below the toolbar is the tab-bar
        // wrapper's own OPAQUE paddingTop instead (Figma 4134:51191).
        pinnedTopInset={insets.top + HOME_HEADER_ROW_HEIGHT}
        renderPage={renderProfilePage}
        scrollY={pagerScrollY}
        shouldStandDown={isSearchFieldFocused}
        tabBar={pagerTabBar}
        testID="portfolio-page-tab-pager"
        value={activeProfileTab}
      />

      {/*
        OUTSIDE the pager, floating. It briefly lived at the top of the pager's
        collapsing block so it would scroll away like Home's — but that block is
        already a pinned chrome LAYER (profile + tab bar, absolutely positioned
        and translated on scroll), so a second in-flow bar inside it fought the
        pinning and left the profile tab bar drawn across the status bar.
      */}
      {homeHeader}

      {editMode ? (
        <View
          style={[
            styles.editBar,
            {
              backgroundColor: theme.colors.gray0,
              paddingBottom: Math.max(insets.bottom, 12),
            },
          ]}
          testID="portfolio-edit-bar"
        >
          {deleteError ? (
            <Text
              style={[theme.typography.overline, styles.editError, { color: theme.colors.dangerStrong }]}
              testID="portfolio-edit-error"
            >
              {deleteError}
            </Text>
          ) : null}
          <Text
            style={[theme.typography.overline, styles.editCount, { color: theme.colors.gray500 }]}
            testID="portfolio-edit-count"
          >
            {`${selectedCount} item${selectedCount === 1 ? '' : 's'} selected`}
          </Text>
          <View style={styles.editActions}>
            {/* Select mode hides the tab bar, so this is the way back out. */}
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleExitSelect}
              style={styles.editAction}
              testID="portfolio-edit-done"
            >
              <Xmark color={theme.colors.gray900} height={22} width={22} />
              <Text style={[theme.typography.caption, { color: theme.colors.gray900 }]}>Done</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleToggleSelectAll}
              style={styles.editAction}
              testID="portfolio-edit-select-all"
            >
              <CheckCircle color={theme.colors.gray900} height={22} width={22} />
              <Text style={[theme.typography.caption, { color: theme.colors.gray900 }]}>
                {allVisibleSelected ? 'Unselect All' : 'Select All'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={selectedCount === 0}
              hitSlop={8}
              onPress={selectedCount === 0 ? undefined : () => setDeleteConfirmOpen(true)}
              style={[styles.editAction, selectedCount === 0 ? styles.editActionDisabled : null]}
              testID="portfolio-edit-delete"
            >
              <Trash color={theme.colors.dangerStrong} height={22} width={22} />
              <Text style={[theme.typography.caption, { color: theme.colors.dangerStrong }]}>
                Delete
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <ConfirmDeleteSheet
        confirmPending={isDeleting}
        message={deleteMessage}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={handleConfirmBulkDelete}
        testID="portfolio-bulk-delete-sheet"
        visible={deleteConfirmOpen}
      />

      <CardActionsSheet
        onClose={closeActionMenu}
        onDismiss={handleActionMenuDismissed}
        onDelete={handleMenuDelete}
        onEdit={handleMenuEdit}
        onSelect={handleMenuSelect}
        onShare={handleMenuShare}
        onWishlist={handleMenuWishlist}
        testID="collection-card-actions"
        title={actionMenuEntry?.name ?? ''}
        visible={actionMenuEntry != null}
      />

      <ConfirmDeleteSheet
        confirmPending={isSingleDeleting}
        onClose={() => setSingleDeleteEntry(null)}
        onConfirm={handleConfirmSingleDelete}
        quantity={singleDeleteEntry?.quantity ?? 1}
        testID="portfolio-single-delete-sheet"
        visible={singleDeleteEntry != null}
      />

      <SalePriceEditSheet
        canConfirm={model.canConfirmSalePriceEdit}
        onChangePriceText={model.updateEditingSalePriceText}
        onClose={model.closeSaleEditor}
        onConfirm={model.confirmSalePriceEdit}
        priceText={model.editingSalePriceText}
        sale={model.editingSale}
      />

      <CollectionPickerSheet
        activeCollectionID={activeCollectionID}
        allTotals={collectionsSnapshot?.all ?? { cardCount: 0, totalValue: 0 }}
        collections={collectionsSnapshot?.collections ?? []}
        formatValue={formatCollectionValue}
        loading={isLoadingCollections}
        onClose={() => setIsCollectionPickerVisible(false)}
        onCreateCollection={handleCreateCollection}
        onDismissed={handleCollectionPickerDismissed}
        onRenameCollection={handleRenameCollection}
        onRequestDelete={handleRequestDeleteCollection}
        onSelectCollection={setActiveCollectionID}
        onToggleHidden={handleToggleCollectionHidden}
        visible={isCollectionPickerVisible}
      />

      {/* Deleting a collection takes its CARDS with it, so the confirm names the
          count instead of asking a generic "are you sure?". */}
      <ConfirmDeleteSheet
        confirmPending={isDeletingCollection}
        message={
          collectionPendingDelete
            ? `${
                collectionPendingDelete.cardCount > 0
                  ? `"${collectionPendingDelete.name}" will be deleted along with all of its cards. Are you sure you want to continue?`
                  : `"${collectionPendingDelete.name}" will be deleted. Are you sure you want to continue?`
              }${collectionDeleteError ? `\n\n${collectionDeleteError}` : ''}`
            : undefined
        }
        onClose={() => setCollectionPendingDelete(null)}
        onConfirm={handleConfirmDeleteCollection}
        testID="collection-delete-confirm"
        title="Delete collection"
        visible={collectionPendingDelete !== null}
      />

      {/* One-off action feedback for the actions-menu Wishlist toggle — a
          transient Toast (same treatment as the public profile's failed DM)
          rather than an inline StateCard, since the Collection stays usable and
          nothing has to be dismissed to keep browsing. */}
      <Toast
        message={wishlistToast ?? ''}
        onDismiss={() => setWishlistToast(null)}
        style={[
          styles.wishlistToast,
          {
            // The toast FLOATS, so it clears the chrome the same way the FABs do
            // — not with `bottomNavClearance`, which is list padding sized off the
            // retired JS nav pill's tokens (`bottomNavHeight` 72). See
            // `@/lib/tab-bar-insets`.
            bottom: wishlistToastBottom,
            left: theme.layout.pageGutter,
            right: theme.layout.pageGutter,
          },
        ]}
        testID="collection-wishlist-toast"
        tone="dark"
        visible={wishlistToast !== null}
      />
    </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({

  chartWrap: {
    // Figma 6502:7715: 24 from the % change line to the time filter, 18 from
    // the plot's bottom edge to the collection summary (chrome's gap is 16).
    marginBottom: 2,
    marginTop: 12,
  },
  searchRowWrap: {
    marginBottom: SEARCH_TO_CHIPS_GAP - 16,
  },
  chrome: {
    // Mirror the legacy ScrollView `content` gap so the balance/chart/search/
    // filter chrome keeps its original 16px inter-child spacing. The tail sets
    // the gap from the filter chips to the first card row to 16px (Figma
    // 1252:2596) — the first row carries only a top hairline, no padding.
    gap: 16,
    paddingBottom: 16,
  },
  // The profile block inside the pinned chrome. Pulls the tab-bar wrapper's
  // rounded, opaque top band UP over this header's cover bottom, so the
  // sheet-top -> label gap is 16 once (not stacked) and the bar's corners
  // notch into the cover. The overlap is deeper than that 16 so the
  // continuous corners finish over the photo — see `PROFILE_SHEET_OVERLAP`.
  // The bar paints above this sibling by tree order.
  pinnedBlock: {
    marginBottom: -PROFILE_SHEET_OVERLAP,
  },
  emptyPrompt: {
    // Same top offset as the filter-miss StateCard so both empty states sit at
    // the same distance below the filter chips.
    marginTop: 12,
  },
  // Claim the page's leftover height and centre the prompt in it — see the note
  // on `listEmpty`. `flexGrow` rather than `flex: 1`: the empty component is a
  // child of the list's content container alongside the header, so it must be
  // allowed to GROW into the slack without also being told it may shrink to
  // nothing when the header is tall.
  // Drops only the screenful floor. The bottom-nav clearance stays: under a
  // tall profile header + chart + filters the empty card reaches the floating
  // tab bar and must scroll clear of it (user, 2026-11-21).
  emptyListContent: {
    minHeight: 0,
  },
  emptyStateCard: {
    marginTop: 12,
  },
  // "In other collections" — same page gutter as the rest of the chrome; the
  // vertical padding separates it from the active section's last ruled row.
  crossSectionHeader: {
    paddingBottom: 12,
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  staleHint: {
    paddingHorizontal: 16,
  },
  editBar: {
    alignItems: 'center',
    bottom: 0,
    left: 0,
    paddingTop: 12,
    position: 'absolute',
    right: 0,
  },
  editError: {
    paddingBottom: 4,
    paddingHorizontal: 16,
    textAlign: 'center',
  },
  editCount: {
    paddingBottom: 4,
  },
  editActions: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 8,
  },
  editAction: {
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  editActionDisabled: {
    opacity: 0.4,
  },
  listWrap: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  wishlistToast: {
    position: 'absolute',
    zIndex: 5,
  },
});

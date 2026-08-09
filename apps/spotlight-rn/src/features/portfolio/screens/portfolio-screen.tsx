import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  type LayoutChangeEvent,
  Linking,
  Pressable,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  RefreshControl,
  type ScrollView,
  Share,
  StyleSheet,
  type TextInput,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { CheckCircle, Trash } from 'iconoir-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ALL_COLLECTIONS_ID } from '@spotlight/api-client';
import type { Collection, CollectionsSnapshot, InventoryCardEntry } from '@spotlight/api-client';
import {
  Avatar,
  EmptyStatePrompt,
  InlineLoader,
  PageTabs,
  type PageTab,
  StateCard,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import {
  PortfolioChartCard,
  type PortfolioChartActivePoint,
} from '@/features/portfolio/components/portfolio-chart-card';
import { PortfolioBalanceHeader } from '@/features/portfolio/components/portfolio-balance-header';
import {
  HIDDEN_VALUE_MASK,
  formatAbbreviatedCurrency,
} from '@/features/portfolio/components/portfolio-formatting';
import { SalePriceEditSheet } from '@/features/portfolio/components/sale-price-edit-sheet';
import { CollectionPickerSheet } from '@/features/portfolio/components/collection-picker-sheet';
import { CollectionSearchRow } from '@/features/portfolio/components/collection-search-row';
import { HomeHeader, SEARCH_PILL_HIDE_DISTANCE } from '@/components/home-header';
import {
  CollectionFilterChipRow,
  type CollectionFilterKey,
} from '@/features/portfolio/components/collection-filter-chip-row';
import {
  CollectionGridRow,
  CollectionGridSingleRow,
  chunkCollectionGridRows,
} from '@/features/portfolio/components/collection-masonry-grid';
import { CollectionListRow } from '@/features/portfolio/components/collection-list-view';
import { CardActionsSheet } from '@/features/cards/components/card-actions-sheet';
import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';
import { DrawerEdgeSwipe } from '@/components/drawer-edge-swipe';
import {
  AnimatedFlatList,
  AnimatedScrollView,
  CollapsibleTabPager,
  PageSwipeGuard,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import { EkalightMark } from '@/components/ekalight-mark';
import { ScanTabIcon } from '@/components/nav-tab-icons';
import { ScrollToTopFab, useScrollToTop } from '@/components/scroll-to-top-fab';
import { usePortfolioScreenModel } from '@/features/portfolio/hooks/use-portfolio-screen-model';
import { usePortfolioViewMode } from '@/features/portfolio/hooks/use-portfolio-view-mode';
import { usePortfolioSummaryVisibility } from '@/features/portfolio/use-portfolio-summary-visibility';
import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useTabsPage } from '@/contexts/tabs-page-context';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { resolveRepositoryBaseUrl, useAppServices } from '@/providers/app-providers';
import { PostCard } from '@/features/social/components/post-card';
import {
  type FeedPost,
  type FeedPostAuthor,
  fetchAuthorPosts,
} from '@/features/social/social-service';
import { useUnreadNotificationCount } from '@/features/social/use-unread-notification-count';
import { usePostDeletion } from '@/features/social/use-post-deletion';
import { consumeFeedRefreshSignal } from '@/features/social/screens/new-post-screen';
import { ProfileHeader } from '@/features/profile/components/profile-header';
import { getResolvedDisplayName, getUserInitials } from '@/features/auth/auth-models';
import { useAuth } from '@/providers/auth-provider';

const GRID_TEST_ID = 'collection-masonry-grid';

// Empty-collection onboarding copy (Figma 3370:4175). The apostrophe is the
// typographic U+2019 the design uses, not a straight quote.
const COLLECTION_EMPTY_MESSAGE = 'Let’s build your collection';

// Figma nav-glyph size, shared with the bottom tab bar (node 1313:7454).
const SCAN_GLYPH_SIZE = 22;

// The public "Portfolio" profile tabs. Only Collection is wired for now; For Sale
// renders a gated "Coming soon" state until its roadmap phase ships; Activity is live (Phase 3a).
type ProfileTab = 'collection' | 'forsale' | 'activity';
const PROFILE_TABS: readonly PageTab<ProfileTab>[] = [
  { value: 'collection', label: 'Collection' },
  { value: 'forsale', label: 'For Sale' },
  { value: 'activity', label: 'Activity' },
];
// Left→right order the horizontal page swipe walks. Derived from PROFILE_TABS so
// the two can never disagree about which tab is "next".
const PROFILE_TAB_ORDER = PROFILE_TABS.map((tab) => tab.value);

// Press-and-hold duration before a card's actions menu opens — a standard
// long-press (iOS context menus sit around here).
const CARD_LONG_PRESS_MS = 500;

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
const TABS_TO_BALANCE_GAP = 24;

type PortfolioScreenProps = {
  onOpenInventoryEntry?: (entry: InventoryCardEntry) => void;
};

// One virtualized row of the collection list. In list view each entry is its
// own row; in card view a row holds up to two tiles (or a single boxed tile
// when the collection has exactly one card).
type CollectionRow =
  | { kind: 'list'; key: string; entry: InventoryCardEntry; firstInSection: boolean }
  | { kind: 'grid'; key: string; rowEntries: InventoryCardEntry[]; rowIndex: number }
  | { kind: 'grid-single'; key: string; entry: InventoryCardEntry }
  | { kind: 'post'; key: string; post: FeedPost };

/** Has the owner's Activity posts loaded? */
type ActivityStatus = 'idle' | 'loading' | 'ready' | 'error';

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

// Parse an ISO timestamp to epoch ms; missing/invalid sort oldest (so they land
// last under a descending "most recent first" sort).
function timestampMs(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

export function applyCollectionFilter(
  items: InventoryCardEntry[],
  filter: CollectionFilterKey,
): InventoryCardEntry[] {
  switch (filter) {
    case 'all':
      // Recently added first.
      return [...items].sort((a, b) => timestampMs(b.addedAt) - timestampMs(a.addedAt));
    case 'az':
      return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    case 'price':
      return [...items].sort((a, b) => {
        const ap = a.hasMarketPrice ? a.marketPrice : -Infinity;
        const bp = b.hasMarketPrice ? b.marketPrice : -Infinity;
        return bp - ap;
      });
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
}: PortfolioScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const auth = useAuth();
  const currentUser = auth.currentUser;
  // Public profile tab (Collection / For Sale / Activity). Only Collection is
  // live; the others show a "Coming soon" placeholder until their phases ship.
  const [activeProfileTab, setActiveProfileTab] = useState<ProfileTab>('collection');
  // Owner Activity tab (Phase 3a): the signed-in user's own posts, plus the
  // backend proxy base + bearer the post images stream through.
  const accessToken = auth.accessToken;
  const apiBaseUrl = resolveRepositoryBaseUrl();
  const [activityPosts, setActivityPosts] = useState<FeedPost[]>([]);
  const [activityStatus, setActivityStatus] = useState<ActivityStatus>('idle');
  // Bumped to force an Activity re-fetch (e.g. after composing a post).
  const [activityReloadToken, setActivityReloadToken] = useState(0);
  // Which user's Activity posts have already been requested, so re-selecting the
  // tab doesn't refetch.
  const activityLoadedRef = useRef<string | null>(null);
  const profileName = currentUser ? getResolvedDisplayName(currentUser) : 'Portfolio';
  const profileInitials = currentUser ? getUserInitials(currentUser) : 'P';
  const handleSocialLinkPress = useCallback(() => {
    const link = currentUser?.socialLink;
    if (!link) {
      return;
    }
    const url = /^https?:\/\//i.test(link) ? link : `https://${link}`;
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
    };
  }, [currentUser?.handle, currentUser?.id]);

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
  // Guests are kept out of Collection by the pager lock + the gated Collection
  // tab/drawer entries instead.
  const model = usePortfolioScreenModel();
  const {
    spotlightRepository,
    refreshData,
    removeOptimisticInventoryEntries,
    activeCollectionID,
    setActiveCollectionID,
  } = useAppServices();
  const [isCollectionPickerVisible, setIsCollectionPickerVisible] = useState(false);
  const [collectionsSnapshot, setCollectionsSnapshot] = useState<CollectionsSnapshot | null>(null);
  const [isLoadingCollections, setIsLoadingCollections] = useState(false);
  const [collectionPendingDelete, setCollectionPendingDelete] = useState<Collection | null>(null);
  // An action to run only AFTER the collection picker's modal has fully gone —
  // same rule as the card actions menu below: a second overFullScreen modal
  // cannot present while the first is still up.
  const pendingPickerDismissActionRef = useRef<(() => void) | null>(null);
  const [isDeletingCollection, setIsDeletingCollection] = useState(false);
  const [collectionDeleteError, setCollectionDeleteError] = useState<string | null>(null);
  const { isHidden: isSummaryHidden, toggle: toggleSummaryHidden } = usePortfolioSummaryVisibility();
  const { viewMode, toggleViewMode } = usePortfolioViewMode();
  const { openDrawer } = useAppDrawer();
  const { setCollectionEditing } = useTabsPage();
  const handleTabBarScroll = useTabBarScrollHandler();
  const [activeChartPoint, setActiveChartPoint] = useState<PortfolioChartActivePoint | null>(null);
  const [isChartScrubbing, setIsChartScrubbing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<CollectionFilterKey>('all');
  // Bulk multi-select "edit mode" (Figma). While active the bottom tab bar +
  // horizontal page swipe are locked (via setCollectionEditing) and tapping a
  // card toggles selection instead of opening it.
  const [editMode, setEditMode] = useState(false);
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
  const [singleDeleteEntry, setSingleDeleteEntry] = useState<InventoryCardEntry | null>(null);
  const [isSingleDeleting, setIsSingleDeleting] = useState(false);
  // One scroller per page tab. The pager keeps their vertical offsets in step
  // so a horizontal swipe can never reveal a page whose header sits somewhere
  // else; `scrollRef` (Collection) is also the one the scroll-to-top FAB and
  // the search-focus scroll drive, since it is the only long list.
  const scrollRef = useRef<FlatList<CollectionRow>>(null);
  const forSaleScrollRef = useRef<ScrollView>(null);
  const activityScrollRef = useRef<FlatList<CollectionRow>>(null);
  const pageScrollRefs = useMemo<
    Partial<Record<ProfileTab, { readonly current: CollapsibleScrollTarget | null }>>
  >(
    () => ({
      collection: scrollRef,
      forsale: forSaleScrollRef,
      activity: activityScrollRef,
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

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const shouldShowInitialError = !model.hasLoadedDashboard
    && !model.hasLoadedInventory
    && !model.isLoading
    && model.loadError !== null;

  const summary = model.dashboard.summary;
  const baseInventory = model.dashboard.inventoryItems;

  // Abbreviated total on the collection summary line (Figma 2749:4753). It
  // honours the balance-visibility toggle — otherwise hiding the big balance
  // would leak the same number one row further down.

  // The pager writes its scroll offset here; this screen only READS it, and
  // hands it to `HomeHeader` raw so the bar can slide the pill out. Driving that
  // off the same value the header collapse runs on keeps the pill glued to the
  // page rather than a JS frame behind the finger.
  const pagerScrollY = useRef(new Animated.Value(0)).current;
  // `pointerEvents` is not animatable, so the departed pill is disarmed from JS
  // or it stays an invisible tap target over the collection.
  const [isSearchPillHidden, setIsSearchPillHidden] = useState(false);

  const collectionTotalLabel = isSummaryHidden
    ? HIDDEN_VALUE_MASK
    : formatAbbreviatedCurrency(summary.currentValue);

  // Name shown on the picker. Falls back to "All Collection" for the aggregate,
  // and to the plain label until the collections read lands.
  const activeCollectionName = useMemo(() => {
    const collections = collectionsSnapshot?.collections ?? [];
    if (activeCollectionID === ALL_COLLECTIONS_ID) {
      // With a single collection the aggregate IS that collection, so name it —
      // "All Collection" only earns its place once there is more than one
      // (Figma 3356:2371 rests on "Main Collection").
      return collections.length === 1 ? collections[0].name : 'All Collection';
    }
    const match = collections.find((collection) => collection.id === activeCollectionID);
    return match?.name ?? 'Main Collection';
  }, [activeCollectionID, collectionsSnapshot]);

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
    }
  }, [spotlightRepository]);

  // Read the collections once so the picker label is right before it is opened.
  // Deliberately does NOT change the active scope: the unscoped read is already
  // correct for someone who has not picked a collection, and switching the scope
  // here would cost a second (expensive) dashboard fetch on every cold start.
  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

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
        // If the deleted one was on screen, fall back to the aggregate rather
        // than leaving the tab scoped to a collection that no longer exists.
        if (activeCollectionID === target.id) {
          setActiveCollectionID(ALL_COLLECTIONS_ID);
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

  const visibleInventory = useMemo(() => {
    const present = removedIds.size > 0
      ? baseInventory.filter((entry) => !removedIds.has(entry.id))
      : baseInventory;
    const filtered = applyCollectionFilter(present, activeFilter);
    return applyInventorySearch(filtered, model.searchQuery);
  }, [activeFilter, baseInventory, model.searchQuery, removedIds]);

  // Prefetch the owner's own posts as soon as we know who they are, rather than
  // waiting for the Activity tab to be tapped — the round trip then overlaps
  // with the Collection load instead of starting cold on tab switch, so Activity
  // is usually already populated by the time it's opened.
  // `activityReloadToken` bumps to force a re-fetch after composing a post.
  const ownerId = currentUser?.id ?? null;
  const ownerAuthor = useMemo<FeedPostAuthor | null>(() => (
    currentUser
      ? {
          displayName: getResolvedDisplayName(currentUser),
          handle: currentUser.handle ?? null,
          avatarUrl: currentUser.avatarURL ?? null,
          isVerified: currentUser.isVerified === true,
        }
      : null
  ), [currentUser]);
  useEffect(() => {
    if (!ownerId || activityLoadedRef.current === ownerId) {
      return;
    }
    activityLoadedRef.current = ownerId;
    let cancelled = false;
    setActivityStatus('loading');
    void (async () => {
      // The author of every row is the signed-in user, whose profile we already
      // hold — passing it skips the `public_profiles` hydration round trip.
      const loaded = await fetchAuthorPosts(ownerId, { knownAuthor: ownerAuthor });
      if (cancelled) {
        return;
      }
      setActivityPosts(loaded);
      setActivityStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
    // `ownerAuthor` is display-only here; re-running on every profile edit would
    // refetch the list for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerId, activityReloadToken]);

  // The composer flips a one-shot refresh flag on a successful post. Consume it
  // when this screen regains focus and force the owner's Activity to reload —
  // otherwise the lazy-load ref keeps the stale, pre-post list and the new post
  // never appears (the "I posted but see nothing" bug).
  useFocusEffect(
    useCallback(() => {
      if (consumeFeedRefreshSignal()) {
        activityLoadedRef.current = null;
        setActivityReloadToken((token) => token + 1);
      }
    }, []),
  );

  // Unread badge on the bell. Shared with Home, which draws the same bar — see
  // the hook for why it refreshes on focus rather than on a timer.
  const unreadNotifications = useUnreadNotificationCount();

  // Mirror edit mode into the tabs pager so it hides the bottom tab bar + locks
  // the horizontal swipe, and always release the lock on unmount.
  useEffect(() => {
    setCollectionEditing(editMode);
  }, [editMode, setCollectionEditing]);

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

  const {
    isVisible: showScrollTop,
    handleScroll,
    handleLayout,
    scrollToTop,
  } = useScrollToTop(scrollRef, handleTabBarScroll);

  const handlePressEntry = useCallback(
    (entry: InventoryCardEntry) => {
      if (editMode) {
        toggleSelected(entry.id);
        return;
      }
      onOpenInventoryEntry(entry);
    },
    [editMode, onOpenInventoryEntry, toggleSelected],
  );

  // Press-and-hold a card → a "click" haptic + the actions menu (skipped during
  // multi-select edit mode, where a tap toggles selection instead).
  const handleLongPressEntry = useCallback(
    (entry: InventoryCardEntry) => {
      if (editMode) {
        return;
      }
      triggerSelectionHaptic();
      setActionMenuEntry(entry);
    },
    [editMode],
  );

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
    const url = entry.listingUrl ?? undefined;
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

  const handleMenuWishlist = useCallback(() => {
    const entry = actionMenuEntry;
    setActionMenuEntry(null);
    if (!entry) {
      return;
    }
    void spotlightRepository
      .setCardFavorite(entry.cardId, !entry.isFavorite)
      .then(() => refreshData())
      .catch(() => undefined);
  }, [actionMenuEntry, refreshData, spotlightRepository]);

  const handleMenuDuplicate = useCallback(() => {
    const entry = actionMenuEntry;
    setActionMenuEntry(null);
    if (!entry) {
      return;
    }
    void spotlightRepository
      .createInventoryEntry({
        cardID: entry.cardId,
        slabContext: entry.slabContext ?? null,
        variantName: entry.kind === 'raw' ? entry.variantName ?? null : null,
        condition: entry.kind === 'raw' ? entry.conditionCode ?? null : null,
        quantity: 1,
        sourceScanID: null,
        addedAt: new Date().toISOString(),
        costBasisPerUnit: entry.costBasisPerUnit ?? null,
        // Duplicating a card keeps it in the collection you are viewing.
        collectionID: activeCollectionID,
      })
      .then(() => refreshData())
      .catch(() => undefined);
  }, [actionMenuEntry, activeCollectionID, refreshData, spotlightRepository]);

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

  // The top bar's "Search Cards" pill opens the catalog search, which presents
  // as a full-screen modal up from the bottom (see the `(sheet)` group in the
  // root layout). It used to scroll down to the inline collection-filter field,
  // which reads as the same affordance as the search row already on the page —
  // the top bar is for finding a card, not for filtering what you own.
  const handleTopSearchPress = useCallback(() => {
    router.push('/catalog/search' as never);
  }, [router]);

  // The top bar's `+`, which follows the tab you are on: composing a post on
  // Activity, adding a card anywhere else.
  const handleTopAddPress = useCallback(() => {
    if (activeProfileTab === 'activity') {
      router.push('/new-post' as never);
      return;
    }
    router.push('/catalog/search' as never);
  }, [activeProfileTab, router]);

  const handleEditProfilePress = useCallback(() => {
    router.push('/edit-profile' as never);
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
    if (viewMode === 'list') {
      return visibleInventory.map((entry, index) => ({
        kind: 'list',
        key: entry.id,
        entry,
        firstInSection: index === 0,
      }));
    }
    if (visibleInventory.length === 1) {
      return [{ kind: 'grid-single', key: visibleInventory[0].id, entry: visibleInventory[0] }];
    }
    return chunkCollectionGridRows(visibleInventory).map((rowEntries, rowIndex) => ({
      kind: 'grid',
      key: rowEntries[0]?.id ?? `grid-row-${rowIndex}`,
      rowEntries,
      rowIndex,
    }));
  }, [shouldShowInitialError, viewMode, visibleInventory]);

  const activityData = useMemo<CollectionRow[]>(
    () => activityPosts.map((post) => ({ kind: 'post', key: post.id, post })),
    [activityPosts],
  );

  const handleOpenPostCard = useCallback(
    (cardId: string) => {
      router.push({ pathname: '/cards/[cardId]', params: { cardId } });
    },
    [router],
  );

  // Activity holds its own copy of the owner's posts (the feed holds another), so
  // deletion is wired per-list through the shared hook rather than a shared store.
  const { requestDelete: requestPostDelete, confirmSheet: postDeleteSheet } = usePostDeletion(
    setActivityPosts,
    { testID: 'portfolio-activity-delete-confirm' },
  );

  const renderItem = useCallback(
    ({ item }: { item: CollectionRow }) => {
      if (item.kind === 'post') {
        // Full-bleed: the post card owns its own 16px inner padding and its image
        // spans edge-to-edge (Figma 2903-7128), so no page-gutter wrapper here.
        return (
          <PostCard
            accessToken={accessToken}
            apiBaseUrl={apiBaseUrl}
            onPressCard={handleOpenPostCard}
            onRequestDelete={requestPostDelete}
            post={item.post}
            testID="portfolio-activity-post"
          />
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
          isFirstRow={item.rowIndex === 0}
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
      accessToken,
      apiBaseUrl,
      editMode,
      handleLongPressEntry,
      handleOpenPostCard,
      handlePressEntry,
      requestPostDelete,
      selectedIds,
    ],
  );

  /*
    Home's floating top bar (Figma 3505:14521) — menu, the "Search Cards" pill,
    notifications, `+`. It hovers over the scrolling content rather than sitting
    above it, so the buttons are glass and the bar has no background of its own.

    This replaced four separate corner bubbles. Two of them changed job:
      - SEARCH is now the pill, which is the whole point of the design: a target
        the width of the screen instead of a 44pt magnifier, and one that says
        what it searches. It fades out as you scroll while the bubbles stay.
      - EDIT PROFILE moved onto the profile block below (`ProfileHeader`'s own
        edit control), where it belongs with the rest of "you" — the bar has room
        for four controls and the design spends the fourth on `+`.
    A Share bubble from Figma 3095:7044 sat here before that, wired to
    `onPress={() => {}}` — present but inert, because sharing was never built.
    It can come back when it does something, or move into the drawer.
  */
  const homeHeader = (
    <HomeHeader
      addAccessibilityLabel={activeProfileTab === 'activity' ? 'New post' : 'Add a card'}
      onOpenAdd={handleTopAddPress}
      onOpenMenu={openDrawer}
      onOpenNotifications={() => router.push('/notifications' as never)}
      floating
      onOpenSearch={handleTopSearchPress}
      scrollY={pagerScrollY}
      searchInteractive={!isSearchPillHidden}
      testID="portfolio-header"
      unreadCount={unreadNotifications}
    />
  );

  // ── The PINNED chrome ──────────────────────────────────────────────────────
  // Profile block + tab bar are rendered ONCE, above all three pages. The
  // profile block still scrolls away (the pager translates it up with the active
  // page's offset); the tab bar stops at the top and pins. Both need an opaque
  // background — page content scrolls UNDER them.
  const pagerHeader = (
    <View style={[styles.pinnedBlock, { backgroundColor: theme.colors.gray0 }]}>
      <ProfileHeader
        avatarUrl={currentUser?.avatarURL}
        bio={currentUser?.bio}
        // Without this your cover shows on Edit Profile and on your PUBLIC
        // profile, but not on your own Portfolio — the one place you look first.
        coverUrl={currentUser?.coverURL}
        displayName={profileName}
        followerCount={currentUser?.followerCount}
        followingCount={currentUser?.followingCount}
        handle={currentUser?.handle}
        initials={profileInitials}
        isVerified={currentUser?.isVerified}
        onEditPress={handleEditProfilePress}
        onFollowersPress={handleOpenFollowers}
        onFollowingPress={handleOpenFollowing}
        onSocialLinkPress={handleSocialLinkPress}
        reputation={currentUser?.reputation}
        socialLink={currentUser?.socialLink}
        testID="portfolio-header-title"
      />
    </View>
  );

  const pagerTabBar = (
    <View style={{ backgroundColor: theme.colors.gray0 }}>
      <PageTabs
        onChange={setActiveProfileTab}
        tabs={PROFILE_TABS}
        testID="portfolio-profile-tabs"
        value={activeProfileTab}
      />
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
            message={model.loadError || 'Please try again once your backend is reachable.'}
            title="Could not load your backend data"
            variant="field"
          />
        </View>
      ) : (
        <>
          <View style={{ marginTop: TABS_TO_BALANCE_GAP }}>
            <PortfolioBalanceHeader
              summary={summary}
              activeChartPoint={isChartScrubbing ? activeChartPoint : null}
              isSummaryHidden={isSummaryHidden}
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
              "Search Cards" magnifier that used to sit here was a duplicate of
              the top-bar search bubble (both push /catalog/search), and the
              Select / Done edit-mode toggle was removed alongside it. Edit mode
              itself is still wired below — it just has no entry point on this
              row right now. */}
          <View onLayout={handleSearchRowLayout}>
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
              activeFilter={activeFilter}
              onFilterChange={setActiveFilter}
            />
          </PageSwipeGuard>
        </>
      )}
    </View>
  );

  // Empty Activity: once the (empty) posts have actually loaded, show the Figma
  // "What's on your mind?" compose prompt (avatar + gray placeholder, 3147:10061)
  // that opens the composer on tap — not a dead "No posts yet" card. While the
  // posts are still loading (or errored) fall back to a state card.
  const activityEmpty =
    activityStatus === 'ready' ? (
      <Pressable
        accessibilityLabel="Create a post"
        accessibilityRole="button"
        onPress={() => router.push('/new-post' as never)}
        style={({ pressed }) => [styles.composePrompt, { opacity: pressed ? 0.7 : 1 }]}
        testID="portfolio-activity-empty"
      >
        <Avatar initials={profileInitials} size={40} uri={currentUser?.avatarURL} />
        <Text style={[theme.typography.body, { fontSize: 14, color: theme.colors.gray600 }]}>
          What&rsquo;s on your mind?
        </Text>
      </Pressable>
    ) : activityStatus === 'error' ? (
      <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
        <StateCard
          message="Please try again in a moment."
          style={styles.emptyStateCard}
          testID="portfolio-activity-empty"
          title="Could not load activity"
          variant="field"
        />
      </View>
    ) : (
      // Still fetching: a chromeless spinner, not a bordered card — the card
      // reads as a permanent result when it's really just a transient wait.
      <InlineLoader label="Fetching posts" testID="portfolio-activity-empty" />
    );

  // Truly-empty collection (no cards at all) reads differently from an active
  // filter/search that just matched nothing. A filter miss is a RESULT, so it
  // keeps the bordered StateCard; a brand-new collection is an INVITATION, so
  // it gets the Figma onboarding prompt (3370:4175): the Ekalight mark, one
  // encouraging line, and a soft chip straight into the scanner.
  const listEmpty = shouldShowInitialError ? null : (
    <View
      style={[
        { paddingHorizontal: theme.layout.pageGutter },
        /*
          A truly-empty collection CENTRES its prompt; a filter that matched
          nothing does not.

          Every page carries `minHeight: screenHeight + collapseDistance` so it
          can absorb the profile-header collapse (see `page-tab-pager`). With no
          cards that leaves a ~200pt prompt at the top of a ~1250pt container and
          about a thousand points of dead white under it. Taking the leftover
          space and centring in it turns that into framing.

          The filter miss keeps its top alignment on purpose: it is a RESULT for
          a query you just typed, and it belongs directly under the chips that
          produced it, not floating in the middle of the screen.
        */
        model.hasInventoryEntries ? null : styles.emptyPromptFill,
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

    if (tab === 'forsale') {
      return (
        <AnimatedScrollView
          ref={forSaleScrollRef}
          contentContainerStyle={page.contentContainerStyle}
          onScroll={page.onScroll}
          scrollEventThrottle={page.scrollEventThrottle}
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

    if (tab === 'activity') {
      return (
        <AnimatedFlatList
          ref={activityScrollRef}
          contentContainerStyle={[
            page.contentContainerStyle,
            { paddingBottom: bottomNavClearance },
          ]}
          data={activityData}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={activityEmpty}
          onScroll={page.onScroll}
          renderItem={renderItem}
          scrollEventThrottle={page.scrollEventThrottle}
          testID="portfolio-activity-page"
        />
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
            // The pager floors every page at a full screen PLUS the header's
            // collapse distance, so switching to a short tab can't spring the
            // collapsed header back open. On an EMPTY collection that floor is
            // all you see: a screenful of blank under "Let's build your
            // collection". Drop it for that one case — there is nothing to
            // scroll, so there is no collapse to preserve, and the prompt sits
            // directly under the chips where it belongs.
            listData.length === 0 ? { minHeight: 0 } : null,
          ]}
          data={listData}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listData.length > 0 ? <View style={styles.footerSpacer} /> : null}
          ListHeaderComponent={collectionChrome}
          onLayout={handleLayout}
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
          testID="portfolio-scroll-view"
        />
      </View>
    );
  };

  // Only the Collection page drives the scroll-to-top FAB and the bottom-bar
  // minimize signal: it is the only page long enough for either to mean
  // anything, and `scrollToTop` targets its ref.
  const handlePageScroll = (tab: ProfileTab, event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (tab === 'collection') {
      handleScroll(event);
    }
    // The SLIDE is native-driven off `pagerScrollY` inside the bar; this only
    // flips the pill's tap target off once it has gone. Runs on every page so
    // the state cannot go stale when a swipe lands on a tab parked further
    // down, and the equality guard means React re-renders on the crossing, not
    // per frame.
    const hidden = event.nativeEvent.contentOffset.y >= SEARCH_PILL_HIDE_DISTANCE;
    setIsSearchPillHidden((previous) => (previous === hidden ? previous : hidden));
  };

  return (
    /*
      Left-edge drag opens the hamburger drawer. This lived in TopTabsPager's pan
      responder and was lost with it — the drawer BUTTON kept working, the drag
      did not.

      WRAPPER, not an edge overlay. As a sibling strip it depended on touches
      hit-testing to it, and the collection list swallowed them first, so the
      gesture never fired. Wrapping means the recogniser sits above everything in
      the tree and sees every touch through the CAPTURE phase — exactly what the
      pager did (`onMoveShouldSetPanResponderCapture`) and for exactly this
      reason. It claims the gesture only once it is unambiguously a drawer swipe,
      which cancels the card underneath; ordinary scrolls are never claimed.
    */
    <DrawerEdgeSwipe>
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
    >
      {/*
        Collapsing profile header, pinned tab bar, drag-following pages beneath.
        INSIDE `DrawerEdgeSwipe`, so the drawer's capture handler is asked first;
        the two never actually race because this one ignores the 24pt left-edge
        band the drawer owns. It is also the FIRST child of the SafeAreaView, so
        the `subviews[0]` walk still reaches the Collection list.
      */}
      <CollapsibleTabPager
        disabled={editMode}
        header={pagerHeader}
        onChange={setActiveProfileTab}
        onPageScroll={handlePageScroll}
        order={PROFILE_TAB_ORDER}
        pageRefs={pageScrollRefs}
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

      <ScrollToTopFab
        onPress={scrollToTop}
        testID="portfolio-scroll-to-top"
        visible={showScrollTop}
      />

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
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleToggleSelectAll}
              style={styles.editAction}
              testID="portfolio-edit-select-all"
            >
              <CheckCircle color={theme.colors.gray900} height={22} width={22} />
              <Text style={[theme.typography.navLabel, { color: theme.colors.gray900 }]}>
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
              <Text style={[theme.typography.navLabel, { color: theme.colors.dangerStrong }]}>
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
        onDuplicate={handleMenuDuplicate}
        onEdit={handleMenuEdit}
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

      {postDeleteSheet}

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
    </SafeAreaView>
    </DrawerEdgeSwipe>
  );
}

const styles = StyleSheet.create({
  chartWrap: {
    // Gap from the % change line down to the time filter (7D/1M/…) is tuned to
    // 32px per feedback. The chrome wrapper already adds a 16px inter-child gap,
    // so this marginTop adds the remaining 16px (16 + 16 = 32px below the balance
    // block).
    marginTop: 16,
    marginBottom: 16,
  },
  chrome: {
    // Mirror the legacy ScrollView `content` gap so the balance/chart/search/
    // filter chrome keeps its original 16px inter-child spacing. The tail sets
    // the gap from the filter chips to the first card row to 16px (Figma
    // 1252:2596) — the first row carries only a top hairline, no padding.
    gap: 16,
    paddingBottom: 16,
  },
  // The profile block inside the pinned chrome. It carries the 16px that the
  // shared header wrapper's `gap` used to put between it and the tab bar.
  pinnedBlock: {
    paddingBottom: 16,
  },
  composePrompt: {
    // Empty-Activity compose prompt (Figma 3147:10061): avatar + gray
    // placeholder in a tappable row, page-gutter aligned.
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 4,
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
  emptyPromptFill: {
    flexGrow: 1,
    justifyContent: 'center',
    // The prompt's own 12pt top offset is for sitting under the chips; centred,
    // it would just bias the block downward.
    marginTop: -12,
  },
  emptyStateCard: {
    marginTop: 12,
  },
  footerSpacer: {
    // Matches the legacy list/grid `paddingBottom: 16` below the last row.
    height: 16,
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
});

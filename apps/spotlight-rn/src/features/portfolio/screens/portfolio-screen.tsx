import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  type LayoutChangeEvent,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { CheckCircle, EditPencil, Menu as MenuIcon, Trash } from 'iconoir-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { IconButton, StateCard, useSpotlightTheme } from '@spotlight/design-system';

import {
  PortfolioChartCard,
  type PortfolioChartActivePoint,
} from '@/features/portfolio/components/portfolio-chart-card';
import { PortfolioBalanceHeader } from '@/features/portfolio/components/portfolio-balance-header';
import { SalePriceEditSheet } from '@/features/portfolio/components/sale-price-edit-sheet';
import { CollectionSearchRow } from '@/features/portfolio/components/collection-search-row';
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
import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { EditDoneButton } from '@/components/edit-done-button';
import { CardActionsSheet } from '@/features/cards/components/card-actions-sheet';
import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';
import { ScrollToTopFab, useScrollToTop } from '@/components/scroll-to-top-fab';
import { usePortfolioScreenModel } from '@/features/portfolio/hooks/use-portfolio-screen-model';
import { usePortfolioViewMode } from '@/features/portfolio/hooks/use-portfolio-view-mode';
import { usePortfolioSummaryVisibility } from '@/features/portfolio/use-portfolio-summary-visibility';
import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useTabsPage } from '@/contexts/tabs-page-context';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAppServices } from '@/providers/app-providers';

const GRID_TEST_ID = 'collection-masonry-grid';

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

type PortfolioScreenProps = {
  onOpenInventoryEntry?: (entry: InventoryCardEntry) => void;
};

// One virtualized row of the collection list. In list view each entry is its
// own row; in card view a row holds up to two tiles (or a single boxed tile
// when the collection has exactly one card).
type CollectionRow =
  | { kind: 'list'; key: string; entry: InventoryCardEntry; firstInSection: boolean }
  | { kind: 'grid'; key: string; rowEntries: InventoryCardEntry[]; rowIndex: number }
  | { kind: 'grid-single'; key: string; entry: InventoryCardEntry };

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
    default:
      return items;
  }
}

export function PortfolioScreen({
  onOpenInventoryEntry = () => {},
}: PortfolioScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const model = usePortfolioScreenModel();
  const { spotlightRepository, refreshData, removeOptimisticInventoryEntries } = useAppServices();
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
  const [singleDeleteEntry, setSingleDeleteEntry] = useState<InventoryCardEntry | null>(null);
  const [isSingleDeleting, setIsSingleDeleting] = useState(false);
  const scrollRef = useRef<FlatList<CollectionRow>>(null);
  // Y offset of the search row within the list header chrome, captured on
  // layout so focusing the field can scroll it into a keyboard-safe position.
  const searchRowYRef = useRef(0);

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

  const visibleInventory = useMemo(() => {
    const present = removedIds.size > 0
      ? baseInventory.filter((entry) => !removedIds.has(entry.id))
      : baseInventory;
    const filtered = applyCollectionFilter(present, activeFilter);
    return applyInventorySearch(filtered, model.searchQuery);
  }, [activeFilter, baseInventory, model.searchQuery, removedIds]);

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

  const handleExitEditMode = useCallback(() => {
    setEditMode(false);
    setSelectedIds(new Set());
    setDeleteError(null);
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
    + "from your Collection. This can't be undone, and your Portfolio value and Insights will be recalculated.";

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
    setActionMenuEntry(null);
    if (!entry) {
      return;
    }
    const message = [entry.name, entry.cardNumber, entry.setName]
      .map((part) => (part ?? '').trim())
      .filter(Boolean)
      .join(' · ');
    const url = entry.listingUrl ?? undefined;
    // Present the native share sheet only AFTER the actions modal has finished
    // dismissing. Firing Share.share() in the same tick races iOS: it tries to
    // present UIActivityViewController while the RN modal's view controller is
    // still on screen / mid-dismiss, so the share sheet flashes and gets torn
    // down with the modal, leaving an orphaned presentation = frozen screen.
    // 280ms clears the sheet's 200ms close animation (same as handleMenuDelete).
    setTimeout(() => {
      void Share.share(url ? { message, url } : { message }).catch(() => undefined);
    }, 280);
  }, [actionMenuEntry]);

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
      })
      .then(() => refreshData())
      .catch(() => undefined);
  }, [actionMenuEntry, refreshData, spotlightRepository]);

  // Delete from the menu: close the menu first, then open the confirm sheet on
  // the next tick (a fresh RN modal can't present while another is still up).
  const handleMenuDelete = useCallback(() => {
    const entry = actionMenuEntry;
    setActionMenuEntry(null);
    if (!entry) {
      return;
    }
    setTimeout(() => setSingleDeleteEntry(entry), 280);
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

  // The search row lives inside the list header, so its content offset is the
  // FlatList's top inset plus its measured y within the header chrome.
  const handleSearchFocus = useCallback(() => {
    const offset = Math.max(
      theme.layout.pageTopInset + searchRowYRef.current - SEARCH_FOCUS_TOP_GAP,
      0,
    );
    scrollRef.current?.scrollToOffset({ offset, animated: true });
  }, [theme.layout.pageTopInset]);

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

  const renderItem = useCallback(
    ({ item }: { item: CollectionRow }) => {
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
    [editMode, handleLongPressEntry, handlePressEntry, selectedIds],
  );

  // Pinned top bar (kept OUT of the FlatList's ListHeaderComponent so it stays
  // fixed while the balance/chart/search/filter chrome and the list scroll under
  // it). The subtle bottom hairline delineates it once content scrolls beneath.
  const stickyHeader = (
    <View
      style={[
        styles.header,
        {
          paddingHorizontal: theme.layout.pageGutter,
          borderBottomColor: theme.colors.outlineSubtle,
        },
      ]}
    >
      <Pressable
        accessibilityLabel="Open menu"
        accessibilityRole="button"
        hitSlop={12}
        onPress={openDrawer}
        style={styles.headerIcon}
        testID="portfolio-header-menu"
      >
        <MenuIcon color={theme.colors.gray900} height={24} width={24} />
      </Pressable>
      <Text
        numberOfLines={1}
        style={[theme.typography.titleMedium, styles.headerTitle]}
        testID="portfolio-header-title"
      >
        Collection
      </Text>
      {editMode ? (
        <EditDoneButton onPress={handleExitEditMode} testID="portfolio-header-done" />
      ) : (
        <IconButton
          accessibilityLabel="Edit collection"
          onPress={() => setEditMode(true)}
          size={36}
          testID="portfolio-header-edit"
          variant="subtle"
        >
          <EditPencil color={theme.colors.gray900} height={20} width={20} />
        </IconButton>
      )}
    </View>
  );

  const listHeader = (
    <View style={styles.chrome}>
      {shouldShowInitialError ? (
        <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
          <StateCard
            message={model.loadError || 'Please try again once your backend is reachable.'}
            title="Could not load your backend data"
            variant="field"
          />
        </View>
      ) : (
        <>
          <PortfolioBalanceHeader
            summary={summary}
            // Only show a hovered point while a scrub is actually active. The
            // scrub-lock flag flips off synchronously on release/terminate, so
            // even if the active-point reset is ever lost (e.g. the chart
            // unmounts mid-scrub) the header can't get stranded on a stale
            // $0.00 baseline — it falls straight back to the real summary.
            activeChartPoint={isChartScrubbing ? activeChartPoint : null}
            isSummaryHidden={isSummaryHidden}
            onToggleHidden={toggleSummaryHidden}
          />

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

          {model.loadError ? (
            <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
              <StateCard
                message={model.loadError}
                title="Could not refresh your backend data"
                variant="field"
              />
            </View>
          ) : model.isDashboardStale ? (
            <Text
              style={[
                theme.typography.captionMedium,
                styles.staleHint,
                { color: theme.colors.gray500 },
              ]}
              testID="portfolio-stale-hint"
            >
              Couldn’t refresh just now — showing your last update.
            </Text>
          ) : null}

          <View onLayout={handleSearchRowLayout}>
            <CollectionSearchRow
              onChangeQuery={model.setSearchQuery}
              onFocus={handleSearchFocus}
              onToggleViewMode={toggleViewMode}
              query={model.searchQuery}
              viewMode={viewMode}
            />
          </View>

          <CollectionFilterChipRow
            activeFilter={activeFilter}
            onFilterChange={setActiveFilter}
          />
        </>
      )}
    </View>
  );

  const listEmpty = shouldShowInitialError ? null : (
    <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
      <StateCard
        message="Add cards from the scanner or tap the + button to start your collection."
        style={styles.emptyStateCard}
        title="No cards match this filter"
      />
    </View>
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
    >
      {stickyHeader}

      <View
        style={styles.listWrap}
        testID={
          shouldShowInitialError
            ? undefined
            : viewMode === 'grid'
              ? 'collection-masonry-grid'
              : 'collection-list-view'
        }
      >
        <FlatList
          ref={scrollRef}
          // Keyboard handling for the in-header search field: inset the scroll
          // content by the keyboard height so a small (e.g. single-result)
          // filtered list can still scroll clear of the keyboard instead of
          // staying trapped half-behind it — this also keeps the focus-scroll
          // offset valid so the list no longer snaps/jumps as results shrink
          // while typing. Swipe-to-dismiss + persist-taps let you reach a result
          // (open the card) without an extra tap to drop the keyboard first.
          automaticallyAdjustKeyboardInsets
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop: theme.layout.pageTopInset,
            paddingBottom: bottomNavClearance,
          }}
          data={listData}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listData.length > 0 ? <View style={styles.footerSpacer} /> : null}
          ListHeaderComponent={listHeader}
          onLayout={handleLayout}
          onScroll={handleScroll}
          refreshControl={(
            <RefreshControl
              onRefresh={model.refresh}
              refreshing={model.isRefreshing}
              testID="portfolio-refresh-control"
              tintColor={theme.colors.gray400}
            />
          )}
          renderItem={renderItem}
          scrollEnabled={!isChartScrubbing}
          scrollEventThrottle={16}
          testID="portfolio-scroll-view"
        />
      </View>

      <ScrollToTopFab
        onPress={scrollToTop}
        testID="portfolio-scroll-to-top"
        visible={showScrollTop}
      />

      {editMode ? null : <CollectionAddFab />}

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

      <SalePriceEditSheet
        canConfirm={model.canConfirmSalePriceEdit}
        onChangePriceText={model.updateEditingSalePriceText}
        onClose={model.closeSaleEditor}
        onConfirm={model.confirmSalePriceEdit}
        priceText={model.editingSalePriceText}
        sale={model.editingSale}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  chartWrap: {
    // Figma puts the Time Filter Container 64px below the Portfolio Balance
    // Container. The chrome wrapper adds a 16px gap between children, so we add
    // 48 here to land at exactly 64.
    marginTop: 48,
    marginBottom: 16,
  },
  chrome: {
    // Mirror the legacy ScrollView `content` gap so the balance/chart/search/
    // filter chrome keeps its original 16px inter-child spacing. The 32px tail
    // reproduces the old spacing above the first ruled row (the parent `gap: 16`
    // between the filters and the list + the list's own `paddingTop: 16`).
    gap: 16,
    paddingBottom: 32,
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
  header: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: 40,
  },
  headerIcon: {
    height: 24,
    width: 24,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
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

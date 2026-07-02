import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle,
  Trash,
} from 'iconoir-react-native';
import { Swipeable } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import type { CardFavoriteEntry } from '@spotlight/api-client';
import {
  CardListRow,
  IconButton,
  PillButton,
  SearchField,
  SelectionCheckCircle,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';
import { ScrollToTopFab, useScrollToTop } from '@/components/scroll-to-top-fab';
import { GridViewIcon, ListViewIcon } from '@/components/view-toggle-icons';
import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { ConfirmDeleteSheet } from '@/features/cards/components/confirm-delete-sheet';
import { saveCardDetailPreviewFromFavorite } from '@/features/cards/card-detail-preview-session';
import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { WishlistHeader } from '@/features/wishlist/components/wishlist-header';
import { useAppServices } from '@/providers/app-providers';

function gradeLabelForFavorite(entry: CardFavoriteEntry): string | null {
  if (entry.slabContext) {
    const grader = (entry.slabContext.grader ?? '').trim();
    const grade = (entry.slabContext.grade ?? '').trim();
    const combined = [grader, grade].filter(Boolean).join(' ');
    if (combined.length > 0) {
      return combined;
    }
  }
  const short = (entry.conditionShortLabel ?? '').trim();
  return short.length > 0 ? short : null;
}

type WishlistFilterKey = 'all' | 'az' | 'price' | 'owned' | 'unowned';
type WishlistViewMode = 'grid' | 'list';

// One virtualized row of the wishlist. List view renders one card per row; card
// view renders up to two tiles per ruled row (or a single boxed tile when the
// wishlist has exactly one card).
type WishlistRow =
  | { kind: 'list'; key: string; entry: CardFavoriteEntry; firstInSection: boolean }
  | { kind: 'grid'; key: string; rowEntries: CardFavoriteEntry[]; rowIndex: number }
  | { kind: 'grid-single'; key: string; entry: CardFavoriteEntry };

const FILTERS: readonly { key: WishlistFilterKey; label: string; hasArrow?: boolean }[] = [
  { key: 'all', label: 'All' },
  { key: 'az', label: 'A-Z' },
  { key: 'price', label: 'Price', hasArrow: true },
  { key: 'unowned', label: 'Unowned' },
  { key: 'owned', label: 'Owned' },
];

const GRID_COLUMNS = 2;

const WISHLIST_VIEW_MODE_STORAGE_KEY = '@spotlight/wishlist/view-mode';
const DEFAULT_VIEW_MODE: WishlistViewMode = 'list';

function chunkWishlistGridRows(entries: CardFavoriteEntry[]): CardFavoriteEntry[][] {
  const rows: CardFavoriteEntry[][] = [];
  for (let index = 0; index < entries.length; index += GRID_COLUMNS) {
    rows.push(entries.slice(index, index + GRID_COLUMNS));
  }
  return rows;
}

function parseViewMode(raw: string | null): WishlistViewMode {
  return raw === 'grid' || raw === 'list' ? raw : DEFAULT_VIEW_MODE;
}

function useWishlistViewMode(): [WishlistViewMode, (next: WishlistViewMode) => void] {
  const [viewMode, setViewModeState] = useState<WishlistViewMode>(DEFAULT_VIEW_MODE);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await AsyncStorage.getItem(WISHLIST_VIEW_MODE_STORAGE_KEY);
        if (!cancelled) {
          setViewModeState(parseViewMode(stored));
        }
      } catch {
        // ignore — keep default
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setViewMode = useCallback((next: WishlistViewMode) => {
    setViewModeState(next);
    void AsyncStorage.setItem(WISHLIST_VIEW_MODE_STORAGE_KEY, next).catch(() => {
      // ignore persistence failure — in-memory state still reflects the toggle
    });
  }, []);

  return [viewMode, setViewMode];
}

export function WishlistScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { spotlightRepository, dataVersion } = useAppServices();
  const [favorites, setFavorites] = useState<CardFavoriteEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<WishlistFilterKey>('all');
  const [viewMode, setViewMode] = useWishlistViewMode();
  // Bulk multi-select "edit mode" (mirrors the Collection screen). While active
  // the FAB + bottom tab bar are hidden, tapping a card toggles selection
  // instead of opening it, and the bottom edit bar drives un-favorite in bulk.
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const scrollRef = useRef<FlatList<WishlistRow>>(null);

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const loadFavorites = useCallback(async () => {
    try {
      const result = await spotlightRepository.getCardFavorites();
      setFavorites(result);
      setErrorMessage(null);
    } catch {
      setErrorMessage('Could not load your wishlist right now.');
    }
  }, [spotlightRepository]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void loadFavorites().finally(() => {
      if (!cancelled) {
        setIsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dataVersion, loadFavorites]);

  const {
    isVisible: showScrollTop,
    handleScroll,
    handleLayout,
    scrollToTop,
  } = useScrollToTop(scrollRef);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await loadFavorites();
    setIsRefreshing(false);
  }, [loadFavorites]);

  const visibleEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    let entries = favorites;
    if (activeFilter === 'owned') {
      entries = entries.filter((entry) => entry.isOwned);
    } else if (activeFilter === 'unowned') {
      entries = entries.filter((entry) => !entry.isOwned);
    }
    if (normalized.length > 0) {
      entries = entries.filter((entry) =>
        [entry.name, entry.cardNumber, entry.setName]
          .join(' ')
          .toLowerCase()
          .includes(normalized),
      );
    }
    if (activeFilter === 'az') {
      entries = [...entries].sort((left, right) => left.name.localeCompare(right.name));
    } else if (activeFilter === 'price') {
      entries = [...entries].sort((left, right) => (right.marketPrice ?? 0) - (left.marketPrice ?? 0));
    }
    return entries;
  }, [activeFilter, favorites, query]);

  const handleOpenDetail = useCallback((entry: CardFavoriteEntry) => {
    // Favorites carry no owned slab → warm the default raw lane + hero image.
    prefetchCardDetail(
      spotlightRepository,
      entry.cardId,
      undefined,
      entry.largeImageUrl ?? entry.imageUrl,
    );
    const previewId = saveCardDetailPreviewFromFavorite(entry);
    router.push({
      pathname: '/cards/[cardId]',
      params: {
        cardId: entry.cardId,
        previewId,
      },
    });
  }, [router, spotlightRepository]);

  const toggleSelected = useCallback((cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  }, []);

  const handleExitEditMode = useCallback(() => {
    setEditMode(false);
    setSelectedIds(new Set());
    setDeleteError(null);
  }, []);

  // Tapping a row/tile toggles its selection in edit mode, else opens its detail
  // page.
  const handlePressEntry = useCallback((entry: CardFavoriteEntry) => {
    if (editMode) {
      toggleSelected(entry.cardId);
      return;
    }
    handleOpenDetail(entry);
  }, [editMode, handleOpenDetail, toggleSelected]);

  // Swipe-to-delete on a row removes it from the wishlist. Drop it optimistically,
  // then persist; re-sync from the backend if the unfavorite didn't stick.
  const handleRemoveEntry = useCallback((cardId: string) => {
    setFavorites((current) => current.filter((favorite) => favorite.cardId !== cardId));
    void spotlightRepository.setCardFavorite(cardId, false).catch(() => {
      void loadFavorites();
    });
  }, [loadFavorites, spotlightRepository]);

  const allVisibleSelected = visibleEntries.length > 0
    && visibleEntries.every((entry) => selectedIds.has(entry.cardId));

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds(allVisibleSelected
      ? new Set()
      : new Set(visibleEntries.map((entry) => entry.cardId)));
  }, [allVisibleSelected, visibleEntries]);

  const selectedCount = selectedIds.size;

  // Bulk un-favorite: optimistically drop the selected cards, then persist each
  // toggle; if any fail, re-sync from the backend (restores the stragglers) and
  // surface an inline error.
  const handleConfirmBulkRemove = useCallback(() => {
    if (selectedIds.size === 0 || isDeleting) {
      return;
    }
    const ids = [...selectedIds];
    setIsDeleting(true);
    setDeleteError(null);
    setFavorites((current) => current.filter((favorite) => !selectedIds.has(favorite.cardId)));
    void Promise.allSettled(ids.map((id) => spotlightRepository.setCardFavorite(id, false)))
      .then((results) => {
        setDeleteConfirmOpen(false);
        setEditMode(false);
        setSelectedIds(new Set());
        if (results.some((result) => result.status === 'rejected')) {
          void loadFavorites();
          setDeleteError('Some cards could not be removed.');
        }
      })
      .finally(() => {
        setIsDeleting(false);
      });
  }, [isDeleting, loadFavorites, selectedIds, spotlightRepository]);

  const handleToggleViewMode = useCallback(() => {
    setViewMode(viewMode === 'list' ? 'grid' : 'list');
  }, [setViewMode, viewMode]);

  const toggleAccessibilityLabel =
    viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view';

  const showLoading = isLoading && favorites.length === 0;
  const hasContent = !showLoading && !errorMessage && visibleEntries.length > 0;

  // The whole screen is one virtualized FlatList: the hero + search + filter
  // chrome rides along as the list header, and the wishlist renders row-by-row
  // (one card per row in list view, two tiles per ruled row in card view) so
  // large wishlists stay smooth without a "View More" gate.
  const listData = useMemo<WishlistRow[]>(() => {
    if (!hasContent) {
      return [];
    }
    if (viewMode === 'list') {
      return visibleEntries.map((entry, index) => ({
        kind: 'list',
        key: entry.cardId,
        entry,
        firstInSection: index === 0,
      }));
    }
    if (visibleEntries.length === 1) {
      return [{ kind: 'grid-single', key: visibleEntries[0].cardId, entry: visibleEntries[0] }];
    }
    return chunkWishlistGridRows(visibleEntries).map((rowEntries, rowIndex) => ({
      kind: 'grid',
      key: rowEntries[0]?.cardId ?? `wishlist-grid-row-${rowIndex}`,
      rowEntries,
      rowIndex,
    }));
  }, [hasContent, viewMode, visibleEntries]);

  const renderItem = useCallback(
    ({ item }: { item: WishlistRow }) => {
      if (item.kind === 'list') {
        return (
          <WishlistListRow
            editMode={editMode}
            entry={item.entry}
            firstInSection={item.firstInSection}
            onDelete={handleRemoveEntry}
            onPress={handlePressEntry}
            selected={editMode && selectedIds.has(item.entry.cardId)}
            theme={theme}
          />
        );
      }
      if (item.kind === 'grid-single') {
        return (
          <WishlistGridSingleRow
            editMode={editMode}
            entry={item.entry}
            onPress={handlePressEntry}
            selectedIds={selectedIds}
            theme={theme}
          />
        );
      }
      return (
        <WishlistGridRow
          editMode={editMode}
          isFirstRow={item.rowIndex === 0}
          onPress={handlePressEntry}
          rowEntries={item.rowEntries}
          rowIndex={item.rowIndex}
          selectedIds={selectedIds}
          theme={theme}
        />
      );
    },
    [editMode, handlePressEntry, handleRemoveEntry, selectedIds, theme],
  );

  // The top bar is pinned (sticky) above the list; only the search + filter
  // chrome rides along as the scrolling list header.
  const listHeader = (
    <View>
      <View style={[styles.controls, { paddingHorizontal: theme.layout.pageGutter }]}>
        <View style={styles.searchRow}>
          <View style={styles.searchFieldWrap}>
            <SearchField
              accessibilityLabel="Search your wishlist"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              containerTestID="wishlist-search-input"
              onChangeText={setQuery}
              placeholder="Search your wishlist"
              returnKeyType="search"
              size="collection"
              surface="muted"
              value={query}
            />
          </View>
          <IconButton
            accessibilityLabel={toggleAccessibilityLabel}
            onPress={handleToggleViewMode}
            shape="rounded"
            size={40}
            testID="wishlist-view-toggle"
            variant="outlined"
          >
            {viewMode === 'list' ? (
              <GridViewIcon color={theme.colors.gray900} size={18} />
            ) : (
              <ListViewIcon color={theme.colors.gray900} size={18} />
            )}
          </IconButton>
        </View>

        <ScrollView
          contentContainerStyle={styles.filterRow}
          horizontal
          showsHorizontalScrollIndicator={false}
          testID="wishlist-filter-row"
        >
          {/* Same chips as the Collection tab: PillButton tone="filter" — white
              pill / gray300 border / gray900 label when idle, solid gray900 pill
              with a white label when selected. The Price chip carries its sort
              arrow as a leading icon whose color follows the selected state
              (mirrors the Insights chip row). */}
          {FILTERS.map((filter) => {
            const isSelected = filter.key === activeFilter;
            return (
              <PillButton
                key={filter.key}
                label={filter.label}
                leading={filter.hasArrow ? (
                  <ArrowUp
                    color={isSelected ? theme.colors.gray0 : theme.colors.gray900}
                    height={12}
                    strokeWidth={2}
                    width={12}
                  />
                ) : undefined}
                onPress={() => setActiveFilter(filter.key)}
                selected={isSelected}
                testID={`wishlist-filter-${filter.key}`}
                tone="filter"
              />
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.listTopSpacer} />
    </View>
  );

  const listEmpty = showLoading ? (
    <Text style={[styles.emptyText, { color: theme.colors.gray600 }]} testID="wishlist-loading">
      Loading your wishlist…
    </Text>
  ) : errorMessage ? (
    <Text style={[styles.emptyText, { color: theme.colors.gray600 }]} testID="wishlist-error">
      {errorMessage}
    </Text>
  ) : (
    <Text style={[styles.emptyText, { color: theme.colors.gray600 }]} testID="wishlist-empty">
      {favorites.length === 0
        ? 'Scan a card to add it to your wishlist.'
        : 'No cards match your filters.'}
    </Text>
  );

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <WishlistHeader
        editMode={editMode}
        onBack={() => router.back()}
        onToggleEditMode={() => (editMode ? handleExitEditMode() : setEditMode(true))}
      />
      <View style={styles.listWrap} testID="wishlist-list">
        <FlatList
          ref={scrollRef}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: bottomNavClearance + 16 },
          ]}
          data={listData}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={listEmpty}
          ListFooterComponent={listData.length > 0 ? <View style={styles.footerSpacer} /> : null}
          ListHeaderComponent={listHeader}
          onLayout={handleLayout}
          onScroll={handleScroll}
          refreshControl={(
            <RefreshControl
              onRefresh={handleRefresh}
              refreshing={isRefreshing}
              testID="wishlist-refresh-control"
              tintColor={theme.colors.gray400}
            />
          )}
          renderItem={renderItem}
          scrollEventThrottle={16}
          testID="wishlist-scroll"
        />
      </View>

      <ScrollToTopFab
        onPress={scrollToTop}
        testID="wishlist-scroll-to-top"
        visible={showScrollTop}
      />

      {editMode ? null : <CollectionAddFab />}
      {editMode ? null : <AppBottomTabBar activeKey="wishlist" dismissToTabs />}

      {editMode ? (
        <View
          style={[
            styles.editBar,
            {
              backgroundColor: theme.colors.gray0,
              paddingBottom: Math.max(insets.bottom, 12),
            },
          ]}
          testID="wishlist-edit-bar"
        >
          {deleteError ? (
            <Text
              style={[theme.typography.overline, styles.editError, { color: theme.colors.dangerStrong }]}
              testID="wishlist-edit-error"
            >
              {deleteError}
            </Text>
          ) : null}
          <Text
            style={[theme.typography.overline, styles.editCount, { color: theme.colors.gray500 }]}
            testID="wishlist-edit-count"
          >
            {`${selectedCount} selected`}
          </Text>
          <View style={styles.editActions}>
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={handleToggleSelectAll}
              style={styles.editAction}
              testID="wishlist-edit-select-all"
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
              testID="wishlist-edit-delete"
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
        confirmLabel="Remove"
        confirmPending={isDeleting}
        message={`You're about to remove ${selectedCount} card${selectedCount === 1 ? '' : 's'} from your Wishlist. Are you sure you want to proceed?`}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={handleConfirmBulkRemove}
        testID="wishlist-bulk-remove-sheet"
        title="Remove from Wishlist"
        visible={deleteConfirmOpen}
      />
    </SafeAreaView>
  );
}

type WishlistListRowProps = {
  editMode?: boolean;
  entry: CardFavoriteEntry;
  firstInSection: boolean;
  onDelete: (cardId: string) => void;
  onPress: (entry: CardFavoriteEntry) => void;
  selected?: boolean;
  theme: ReturnType<typeof useSpotlightTheme>;
};

function WishlistListRow({
  editMode = false,
  entry,
  firstInSection,
  onDelete,
  onPress,
  selected = false,
  theme,
}: WishlistListRowProps) {
  const swipeableRef = useRef<Swipeable>(null);
  // Whether the swipe-to-delete rail is currently revealed. Drives the gesture
  // activation range below so closed rows never claim rightward pans.
  const [deleteRailOpen, setDeleteRailOpen] = useState(false);

  const row = (
    <CardListRow
      cardNumber={entry.cardNumber}
      currencyCode={entry.currencyCode ?? 'USD'}
      firstInSection={firstInSection}
      gradeLabel={gradeLabelForFavorite(entry)}
      imageUrl={entry.smallImageUrl ?? entry.imageUrl ?? null}
      marketPrice={entry.marketPrice ?? null}
      name={entry.name}
      onPress={() => onPress(entry)}
      quantity={1}
      selectable={editMode}
      selected={editMode && selected}
      setName={entry.setName}
      showQuantity={false}
      testID={`wishlist-row-${entry.cardId}`}
      trendChangeAmount={entry.dayChangeAmount ?? null}
    />
  );

  // In edit mode the row is a selection target, so drop swipe-to-delete (the
  // bottom edit bar handles bulk removal instead).
  if (editMode) {
    return row;
  }

  // Swipe the row left to reveal a Delete action that removes it from the
  // wishlist. The rail closes before the optimistic removal so the row doesn't
  // flash back open mid-animation.
  const renderRightActions = () => (
    <Pressable
      accessibilityLabel="Remove from wishlist"
      accessibilityRole="button"
      onPress={() => {
        swipeableRef.current?.close();
        onDelete(entry.cardId);
      }}
      style={[styles.rowDeleteAction, { backgroundColor: theme.colors.dangerStrong }]}
      testID={`wishlist-row-delete-${entry.cardId}`}
    >
      <Trash color={theme.colors.gray0} height={20} width={20} />
      <Text style={[styles.rowDeleteLabel, { color: theme.colors.gray0 }]}>Delete</Text>
    </Pressable>
  );

  return (
    <Swipeable
      ref={swipeableRef}
      // While the delete rail is CLOSED, only claim clear leftward drags (the
      // open-the-rail direction) — rightward pans fall through to the
      // screen-level horizontal page swipe, matching the Collection list view
      // (whose rows claim no horizontal gestures at all). The previous
      // always-[-15, 15] config swallowed every horizontal swipe over a row,
      // which is why list view couldn't page-swipe while grid view could.
      // Once the rail is OPEN the row claims both directions again so a
      // right-swipe still closes it (no `failOffsetX`, so the old
      // abort-on-rightward-jitter bug stays fixed). The 15px gate keeps
      // vertical list scrolls passing through in both states.
      activeOffsetX={deleteRailOpen ? [-15, 15] : -15}
      friction={1.5}
      onSwipeableClose={() => setDeleteRailOpen(false)}
      onSwipeableWillOpen={() => setDeleteRailOpen(true)}
      overshootRight={false}
      renderRightActions={renderRightActions}
      rightThreshold={40}
    >
      {row}
    </Swipeable>
  );
}

type WishlistGridRowProps = {
  rowEntries: CardFavoriteEntry[];
  rowIndex: number;
  isFirstRow: boolean;
  editMode?: boolean;
  selectedIds?: Set<string>;
  onPress: (entry: CardFavoriteEntry) => void;
  theme: ReturnType<typeof useSpotlightTheme>;
};

function WishlistGridRow({
  rowEntries,
  rowIndex,
  isFirstRow,
  editMode = false,
  selectedIds,
  onPress,
  theme,
}: WishlistGridRowProps) {
  return (
    <View
      style={[
        styles.gridRow,
        { borderBottomColor: theme.colors.gray100 },
        // Single hairlines: only the first row draws a top border.
        isFirstRow ? { borderTopColor: theme.colors.gray100, borderTopWidth: 1 } : null,
      ]}
    >
      {Array.from({ length: GRID_COLUMNS }).map((_, colIndex) => {
        const entry = rowEntries[colIndex];
        return (
          <View
            key={entry?.cardId ?? `wishlist-grid-row-${rowIndex}-col-${colIndex}`}
            style={[
              styles.gridCell,
              // Middle vertical divider between the two columns.
              colIndex === 1 && entry
                ? { borderLeftColor: theme.colors.gray100, borderLeftWidth: 1 }
                : null,
            ]}
          >
            {entry ? (
              <WishlistGridTile
                entry={entry}
                onPress={() => onPress(entry)}
                selectable={editMode}
                selected={editMode && !!selectedIds?.has(entry.cardId)}
                theme={theme}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

type WishlistGridSingleRowProps = {
  entry: CardFavoriteEntry;
  editMode?: boolean;
  selectedIds?: Set<string>;
  onPress: (entry: CardFavoriteEntry) => void;
  theme: ReturnType<typeof useSpotlightTheme>;
};

// A lone card shouldn't render as a full-bleed ruled row (a wide rectangle with
// one tile in the corner). Box it at one column's width so the border hugs just
// that card — matching the collection card view's single-item case.
function WishlistGridSingleRow({ entry, editMode = false, selectedIds, onPress, theme }: WishlistGridSingleRowProps) {
  return (
    <View style={styles.gridSingleRow}>
      <View style={[styles.gridSingleCell, { borderColor: theme.colors.gray100 }]}>
        <WishlistGridTile
          entry={entry}
          onPress={() => onPress(entry)}
          selectable={editMode}
          selected={editMode && !!selectedIds?.has(entry.cardId)}
          theme={theme}
        />
      </View>
    </View>
  );
}

type WishlistGridTileProps = {
  entry: CardFavoriteEntry;
  onPress: () => void;
  selectable?: boolean;
  selected?: boolean;
  theme: ReturnType<typeof useSpotlightTheme>;
};

function WishlistGridTile({ entry, onPress, selectable = false, selected = false, theme }: WishlistGridTileProps) {
  const imageUri = entry.smallImageUrl ?? entry.imageUrl ?? null;
  // Graded cards show the grade ("PSA 10"); raw cards show the condition
  // ("NM") — same derivation as the list row (Figma 860-2640 / 863-2270).
  const gradeText = gradeLabelForFavorite(entry);
  const delta = entry.dayChangeAmount ?? 0;
  const showDelta = Number.isFinite(delta) && delta !== 0;
  const isDown = delta < 0;
  const deltaLabel = showDelta ? formatOptionalCurrency(Math.abs(delta), entry.currencyCode) : null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.gridTile,
        { opacity: pressed ? 0.84 : 1 },
      ]}
      testID={`wishlist-grid-tile-${entry.cardId}`}
    >
      {selectable ? (
        <View style={styles.selectBadge} testID={`wishlist-grid-tile-${entry.cardId}-select`}>
          <SelectionCheckCircle selected={!!selected} />
        </View>
      ) : null}
      <View style={styles.gridImageWrap}>
        {imageUri ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            source={{ uri: imageUri }}
            style={styles.gridImage}
            testID={`wishlist-grid-tile-${entry.cardId}-image`}
          />
        ) : (
          <View style={styles.gridImage} />
        )}
      </View>
      <View style={styles.gridTextWrap}>
        <Text
          numberOfLines={2}
          style={[theme.typography.headline, { color: theme.colors.gray900 }]}
        >
          {entry.name}
        </Text>
        {entry.cardNumber || entry.setName ? (
          <Text
            numberOfLines={1}
            style={[styles.gridMeta, { color: theme.colors.gray600 }]}
          >
            {entry.cardNumber}
            {entry.cardNumber && entry.setName ? '  ·  ' : ''}
            {entry.setName}
          </Text>
        ) : null}
        {gradeText ? (
          <Text
            numberOfLines={1}
            style={[styles.gridMeta, { color: theme.colors.gray600 }]}
            testID={`wishlist-grid-tile-${entry.cardId}-grade`}
          >
            {gradeText}
          </Text>
        ) : null}
      </View>
      <View style={styles.gridPriceRow}>
        <Text
          numberOfLines={1}
          style={[styles.gridPrice, { color: theme.colors.gray900 }]}
        >
          {formatOptionalCurrency(entry.marketPrice, entry.currencyCode)}
        </Text>
        {showDelta && deltaLabel ? (
          <View
            style={[
              styles.gridDeltaPill,
              { backgroundColor: isDown ? theme.colors.deltaDownSurface : theme.colors.deltaUpSurface },
            ]}
            testID={`wishlist-grid-tile-${entry.cardId}-delta`}
          >
            {isDown ? (
              <ArrowDown color={theme.colors.deltaDownText} height={12} width={12} />
            ) : (
              <ArrowUp color={theme.colors.deltaUpText} height={12} width={12} />
            )}
            <Text
              style={[
                styles.gridDeltaLabel,
                { color: isDown ? theme.colors.deltaDownText : theme.colors.deltaUpText },
              ]}
            >
              {deltaLabel}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  listWrap: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 0,
  },
  controls: {
    // 16px between the search row and the filter chip row (Figma 1874-21756).
    gap: 16,
    marginTop: 24,
  },
  searchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  searchFieldWrap: {
    flex: 1,
  },
  filterRow: {
    gap: 8,
    paddingRight: 16,
  },
  // 16px gap below the filter row before the first ruled row (Figma 1874-21756
  // rhythm: search → 16 → chips → 16 → grid/list). The old 32px doubled up the
  // removed listContainer marginTop with the list's own paddingTop.
  listTopSpacer: {
    height: 16,
  },
  footerSpacer: {
    height: 16,
  },
  emptyText: {
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingVertical: 32,
    textAlign: 'center',
  },
  // Swipe-to-delete action revealed behind a list row.
  rowDeleteAction: {
    alignItems: 'center',
    flexDirection: 'column',
    gap: 4,
    justifyContent: 'center',
    width: 88,
  },
  rowDeleteLabel: {
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 12,
    lineHeight: 16,
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
  selectBadge: {
    position: 'absolute',
    right: 8,
    top: 8,
    zIndex: 1,
  },
  gridRow: {
    alignItems: 'stretch',
    borderBottomWidth: 1,
    flexDirection: 'row',
  },
  gridCell: {
    flex: 1,
  },
  gridSingleRow: {
    flexDirection: 'row',
  },
  gridSingleCell: {
    // Box the lone tile at one column's width with a full hairline border so it
    // reads as a contained card, not a stretched full-width row.
    borderWidth: 1,
    width: '50%',
  },
  gridTile: {
    // Plain tile — no shell border/fill; the row draws the dividers. Relative so
    // the heart badge anchors to the cell's top-right corner.
    padding: 16,
    position: 'relative',
  },
  gridImageWrap: {
    alignItems: 'center',
    width: '100%',
  },
  gridImage: {
    // Small centered card (Figma 992:9884 — 71x104) so the 20px heart floats
    // clear in the empty top-right corner instead of crowding the art.
    borderRadius: 6,
    height: 104,
    width: 71,
  },
  gridTextWrap: {
    // Card Details: 2px between the title/subtitle/condition/qty lines, 16px
    // below the card image (Figma 992:9883 / 9885).
    gap: 2,
    paddingTop: 16,
  },
  gridMeta: {
    // Label: 13/500/140% gray-600 (Figma 1263:3386/3387/3388).
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 13,
    lineHeight: 18.2,
  },
  gridPriceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    // 16px below the details block (Figma Card Content gap, 992:9883).
    marginTop: 16,
  },
  gridPrice: {
    // Price: 13/700/140% gray-900 (Figma 992:9891).
    flexShrink: 1,
    fontFamily: 'SpotlightBodyBold',
    fontSize: 13,
    lineHeight: 18.2,
  },
  gridDeltaPill: {
    alignItems: 'center',
    borderRadius: 4,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  gridDeltaLabel: {
    // Label: 13/500/140% (Figma 1263:3396).
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 13,
    lineHeight: 18.2,
  },
});

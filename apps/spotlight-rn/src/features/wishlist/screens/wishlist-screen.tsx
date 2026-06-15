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
  Filter as FilterIcon,
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
  SearchField,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';
import { ScrollToTopFab, useScrollToTop } from '@/components/scroll-to-top-fab';
import { GridViewIcon, ListViewIcon } from '@/components/view-toggle-icons';
import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { saveCardDetailPreviewFromFavorite } from '@/features/cards/card-detail-preview-session';
import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { WishlistHero } from '@/features/wishlist/components/wishlist-hero';
import { useAppDrawer } from '@/providers/app-drawer-provider';
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
  const { openDrawer } = useAppDrawer();
  const { spotlightRepository, dataVersion } = useAppServices();
  const [favorites, setFavorites] = useState<CardFavoriteEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<WishlistFilterKey>('all');
  const [viewMode, setViewMode] = useWishlistViewMode();
  const [featuredCardId, setFeaturedCardId] = useState<string | null>(null);
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

  // The hero features the tapped card; it falls back to the first visible entry
  // on load and whenever the selected card is filtered out of the list.
  const featuredEntry = useMemo(() => {
    if (visibleEntries.length === 0) {
      return null;
    }
    const selected = featuredCardId
      ? visibleEntries.find((entry) => entry.cardId === featuredCardId)
      : null;
    return selected ?? visibleEntries[0];
  }, [featuredCardId, visibleEntries]);

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

  // Tapping a row/tile opens its detail page AND features it in the hero, so
  // returning from the PDP shows the card you tapped on top.
  const handleOpenEntry = useCallback((entry: CardFavoriteEntry) => {
    setFeaturedCardId(entry.cardId);
    handleOpenDetail(entry);
  }, [handleOpenDetail]);

  // Swipe-to-delete on a row removes it from the wishlist. Drop it optimistically
  // (clearing the hero if it was the featured card), then persist; re-sync from
  // the backend if the unfavorite didn't stick.
  const handleRemoveEntry = useCallback((cardId: string) => {
    setFeaturedCardId((current) => (current === cardId ? null : current));
    setFavorites((current) => current.filter((favorite) => favorite.cardId !== cardId));
    void spotlightRepository.setCardFavorite(cardId, false).catch(() => {
      void loadFavorites();
    });
  }, [loadFavorites, spotlightRepository]);

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
            entry={item.entry}
            firstInSection={item.firstInSection}
            onDelete={handleRemoveEntry}
            onPress={handleOpenEntry}
            theme={theme}
          />
        );
      }
      if (item.kind === 'grid-single') {
        return (
          <WishlistGridSingleRow entry={item.entry} onPress={handleOpenEntry} theme={theme} />
        );
      }
      return (
        <WishlistGridRow
          isFirstRow={item.rowIndex === 0}
          onPress={handleOpenEntry}
          rowEntries={item.rowEntries}
          rowIndex={item.rowIndex}
          theme={theme}
        />
      );
    },
    [handleOpenEntry, handleRemoveEntry, theme],
  );

  const listHeader = (
    <View>
      <WishlistHero
        entry={featuredEntry}
        onOpenDetail={() => {
          if (featuredEntry) {
            handleOpenDetail(featuredEntry);
          }
        }}
        onOpenMenu={openDrawer}
      />

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
              trailing={(
                <FilterIcon color={theme.colors.gray500} height={16} width={16} />
              )}
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
          {FILTERS.map((filter) => {
            const isSelected = filter.key === activeFilter;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                key={filter.key}
                onPress={() => setActiveFilter(filter.key)}
                style={({ pressed }) => [
                  styles.filterChip,
                  {
                    backgroundColor: theme.colors.gray0,
                    borderColor: isSelected ? theme.colors.brand : theme.colors.gray300,
                    opacity: pressed ? 0.88 : 1,
                  },
                ]}
                testID={`wishlist-filter-${filter.key}`}
              >
                <Text
                  style={[
                    theme.typography.label,
                    { color: theme.colors.gray900 },
                  ]}
                >
                  {filter.label}
                </Text>
                {filter.hasArrow ? (
                  <ArrowUp
                    color={theme.colors.gray900}
                    height={12}
                    strokeWidth={2}
                    width={12}
                  />
                ) : null}
              </Pressable>
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
        ? 'Tap the heart on any card to add it here.'
        : 'No cards match your filters.'}
    </Text>
  );

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
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

      <CollectionAddFab />
      <AppBottomTabBar />
    </SafeAreaView>
  );
}

type WishlistListRowProps = {
  entry: CardFavoriteEntry;
  firstInSection: boolean;
  onDelete: (cardId: string) => void;
  onPress: (entry: CardFavoriteEntry) => void;
  theme: ReturnType<typeof useSpotlightTheme>;
};

function WishlistListRow({ entry, firstInSection, onDelete, onPress, theme }: WishlistListRowProps) {
  const swipeableRef = useRef<Swipeable>(null);

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
      overshootRight={false}
      renderRightActions={renderRightActions}
      rightThreshold={40}
    >
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
        setName={entry.setName}
        showQuantity={false}
        testID={`wishlist-row-${entry.cardId}`}
        trendChangeAmount={entry.dayChangeAmount ?? null}
      />
    </Swipeable>
  );
}

type WishlistGridRowProps = {
  rowEntries: CardFavoriteEntry[];
  rowIndex: number;
  isFirstRow: boolean;
  onPress: (entry: CardFavoriteEntry) => void;
  theme: ReturnType<typeof useSpotlightTheme>;
};

function WishlistGridRow({ rowEntries, rowIndex, isFirstRow, onPress, theme }: WishlistGridRowProps) {
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
              <WishlistGridTile entry={entry} onPress={() => onPress(entry)} theme={theme} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

type WishlistGridSingleRowProps = {
  entry: CardFavoriteEntry;
  onPress: (entry: CardFavoriteEntry) => void;
  theme: ReturnType<typeof useSpotlightTheme>;
};

// A lone card shouldn't render as a full-bleed ruled row (a wide rectangle with
// one tile in the corner). Box it at one column's width so the border hugs just
// that card — matching the collection card view's single-item case.
function WishlistGridSingleRow({ entry, onPress, theme }: WishlistGridSingleRowProps) {
  return (
    <View style={styles.gridSingleRow}>
      <View style={[styles.gridSingleCell, { borderColor: theme.colors.gray100 }]}>
        <WishlistGridTile entry={entry} onPress={() => onPress(entry)} theme={theme} />
      </View>
    </View>
  );
}

type WishlistGridTileProps = {
  entry: CardFavoriteEntry;
  onPress: () => void;
  theme: ReturnType<typeof useSpotlightTheme>;
};

function WishlistGridTile({ entry, onPress, theme }: WishlistGridTileProps) {
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
    gap: 12,
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
  filterChip: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    height: 32,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  // 32px gap below the filter row before the first ruled row, reproducing the
  // old `listContainer` marginTop (16) + the list/grid's own paddingTop (16).
  listTopSpacer: {
    height: 32,
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

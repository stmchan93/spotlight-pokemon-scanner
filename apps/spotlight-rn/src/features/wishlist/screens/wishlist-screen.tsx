import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
  HeartSolid,
} from 'iconoir-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import type { CardFavoriteEntry } from '@spotlight/api-client';
import {
  CardListRow,
  IconButton,
  ListPaginationFooter,
  SearchField,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';
import { GridViewIcon, ListViewIcon } from '@/components/view-toggle-icons';
import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { saveCardDetailPreviewFromFavorite } from '@/features/cards/card-detail-preview-session';
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

const FILTERS: readonly { key: WishlistFilterKey; label: string; hasArrow?: boolean }[] = [
  { key: 'all', label: 'All' },
  { key: 'az', label: 'A-Z' },
  { key: 'price', label: 'Price', hasArrow: true },
  { key: 'unowned', label: 'Unowned' },
  { key: 'owned', label: 'Owned' },
];

const WISHLIST_VIEW_MODE_STORAGE_KEY = '@spotlight/wishlist/view-mode';
const DEFAULT_VIEW_MODE: WishlistViewMode = 'list';
const LIST_PAGE_SIZE = 10;

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
  const scrollRef = useRef<ScrollView>(null);
  const [listVisibleCount, setListVisibleCount] = useState(LIST_PAGE_SIZE);

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

  useEffect(() => {
    setListVisibleCount(LIST_PAGE_SIZE);
  }, [activeFilter, query, viewMode]);

  const handleBackToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

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
    const previewId = saveCardDetailPreviewFromFavorite(entry);
    router.push({
      pathname: '/cards/[cardId]',
      params: {
        cardId: entry.cardId,
        previewId,
      },
    });
  }, [router]);

  // Tapping a row/tile promotes that card into the hero; the detail screen is
  // reached by tapping the hero card image (onOpenDetail).
  const handleFeatureEntry = useCallback((entry: CardFavoriteEntry) => {
    setFeaturedCardId(entry.cardId);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

  const handleToggleViewMode = useCallback(() => {
    setViewMode(viewMode === 'list' ? 'grid' : 'list');
  }, [setViewMode, viewMode]);

  const toggleAccessibilityLabel =
    viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view';

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: bottomNavClearance + 16 },
        ]}
        refreshControl={(
          <RefreshControl
            onRefresh={handleRefresh}
            refreshing={isRefreshing}
            testID="wishlist-refresh-control"
            tintColor={theme.colors.gray400}
          />
        )}
        testID="wishlist-scroll"
      >
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

        <View style={styles.listContainer} testID="wishlist-list">
          {isLoading && favorites.length === 0 ? (
            <Text
              style={[styles.emptyText, { color: theme.colors.gray600 }]}
              testID="wishlist-loading"
            >
              Loading your wishlist…
            </Text>
          ) : errorMessage ? (
            <Text
              style={[styles.emptyText, { color: theme.colors.gray600 }]}
              testID="wishlist-error"
            >
              {errorMessage}
            </Text>
          ) : visibleEntries.length === 0 ? (
            <Text
              style={[styles.emptyText, { color: theme.colors.gray600 }]}
              testID="wishlist-empty"
            >
              {favorites.length === 0
                ? 'Tap the heart on any card to add it here.'
                : 'No cards match your filters.'}
            </Text>
          ) : viewMode === 'list' ? (
            <WishlistListView
              entries={visibleEntries.slice(0, listVisibleCount)}
              onPressEntry={handleFeatureEntry}
            />
          ) : (
            <WishlistGridView
              entries={visibleEntries.slice(0, listVisibleCount)}
              onPressEntry={handleFeatureEntry}
            />
          )}

          {visibleEntries.length > 0 ? (
            <ListPaginationFooter
              canViewMore={visibleEntries.length > listVisibleCount}
              onBackToTop={handleBackToTop}
              onViewMore={() => setListVisibleCount((count) => count + LIST_PAGE_SIZE)}
              testID="wishlist-list-pagination"
            />
          ) : null}
        </View>
      </ScrollView>

      <CollectionAddFab />
      <AppBottomTabBar />
    </SafeAreaView>
  );
}

type WishlistViewProps = {
  entries: CardFavoriteEntry[];
  onPressEntry: (entry: CardFavoriteEntry) => void;
};

function WishlistListView({ entries, onPressEntry }: WishlistViewProps) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.listColumn}>
      {entries.map((entry, index) => (
        <View
          key={entry.cardId}
          style={styles.listRowWrap}
          testID={`wishlist-row-wrap-${entry.cardId}`}
        >
          <CardListRow
            cardNumber={entry.cardNumber}
            currencyCode={entry.currencyCode ?? 'USD'}
            firstInSection={index === 0}
            gradeLabel={gradeLabelForFavorite(entry)}
            imageUrl={entry.smallImageUrl ?? entry.imageUrl ?? null}
            marketPrice={entry.marketPrice ?? null}
            name={entry.name}
            onPress={() => onPressEntry(entry)}
            quantity={1}
            setName={entry.setName}
            testID={`wishlist-row-${entry.cardId}`}
            trendChangeAmount={entry.dayChangeAmount ?? null}
          />
          <View
            pointerEvents="none"
            style={styles.heartBadge}
            testID={`wishlist-row-heart-${entry.cardId}`}
          >
            <HeartSolid color={theme.colors.brand} height={16} width={16} />
          </View>
        </View>
      ))}
    </View>
  );
}

const GRID_COLUMNS = 2;

// Light delta-pill backgrounds, matching the collection tile + wishlist hero.
const DELTA_UP_BACKGROUND = 'rgba(76, 175, 110, 0.15)';
const DELTA_DOWN_BACKGROUND = 'rgba(224, 82, 76, 0.15)';

function WishlistGridView({ entries, onPressEntry }: WishlistViewProps) {
  const theme = useSpotlightTheme();

  // A lone card shouldn't render as a full-bleed ruled row (a wide rectangle
  // with one tile in the corner). Box it at one column's width so the border
  // hugs just that card — matching the collection card view's single-item case.
  const soleEntry = entries.length === 1 ? entries[0] : null;
  if (soleEntry) {
    return (
      <View style={styles.gridContainer} testID="wishlist-grid">
        <View style={styles.gridSingleRow}>
          <View style={[styles.gridSingleCell, { borderColor: theme.colors.gray100 }]}>
            <WishlistGridTile
              entry={soleEntry}
              onPress={() => onPressEntry(soleEntry)}
              theme={theme}
            />
          </View>
        </View>
      </View>
    );
  }

  const rows: CardFavoriteEntry[][] = [];
  for (let index = 0; index < entries.length; index += GRID_COLUMNS) {
    rows.push(entries.slice(index, index + GRID_COLUMNS));
  }

  return (
    <View style={styles.gridContainer} testID="wishlist-grid">
      {rows.map((row, rowIndex) => (
        <View
          key={row[0]?.cardId ?? `wishlist-grid-row-${rowIndex}`}
          style={[
            styles.gridRow,
            { borderBottomColor: theme.colors.gray100 },
            // Single hairlines: only the first row draws a top border.
            rowIndex === 0
              ? { borderTopColor: theme.colors.gray100, borderTopWidth: 1 }
              : null,
          ]}
        >
          {Array.from({ length: GRID_COLUMNS }).map((_, colIndex) => {
            const entry = row[colIndex];
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
                    onPress={() => onPressEntry(entry)}
                    theme={theme}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ))}
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
          style={[theme.typography.bodyMedium, { color: theme.colors.gray900, fontWeight: '600' }]}
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
        <Text
          numberOfLines={1}
          style={[styles.gridMeta, { color: theme.colors.gray600 }]}
          testID={`wishlist-grid-tile-${entry.cardId}-qty`}
        >
          Qty: 1
        </Text>
        <View style={styles.gridPriceRow}>
          <Text
            numberOfLines={1}
            style={[theme.typography.label, styles.gridPrice, { color: theme.colors.gray900 }]}
          >
            {formatOptionalCurrency(entry.marketPrice, entry.currencyCode)}
          </Text>
          {showDelta && deltaLabel ? (
            <View
              style={[
                styles.gridDeltaPill,
                { backgroundColor: isDown ? DELTA_DOWN_BACKGROUND : DELTA_UP_BACKGROUND },
              ]}
              testID={`wishlist-grid-tile-${entry.cardId}-delta`}
            >
              {isDown ? (
                <ArrowDown color={theme.colors.redDelta} height={12} width={12} />
              ) : (
                <ArrowUp color={theme.colors.greenDelta} height={12} width={12} />
              )}
              <Text
                style={[
                  styles.gridDeltaLabel,
                  { color: isDown ? theme.colors.redDelta : theme.colors.greenDelta },
                ]}
              >
                {deltaLabel}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      <View
        pointerEvents="none"
        style={styles.heartBadgeGrid}
        testID={`wishlist-grid-tile-${entry.cardId}-heart`}
      >
        <HeartSolid color={theme.colors.brand} height={20} width={20} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
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
  listContainer: {
    marginTop: 16,
  },
  emptyText: {
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 16,
    paddingVertical: 32,
    textAlign: 'center',
  },
  listColumn: {
    // Rows stack flush (no inter-row gap) and full-bleed (no horizontal
    // gutter) so the per-row top/bottom hairlines run edge to edge and form
    // one continuous ruled list, matching the full-width Figma "Price
    // Container" row (669:8573). Each row keeps its own 16px content padding.
    paddingVertical: 16,
  },
  listRowWrap: {
    position: 'relative',
  },
  // Purple filled heart at the top of the row thumbnail (Figma 863-2079),
  // moved up from the old bottom-corner badge.
  heartBadge: {
    left: 58,
    position: 'absolute',
    top: 12,
  },
  gridContainer: {
    // Full-bleed ruled grid (matches the collection card view): rows stack with
    // full-width top/bottom hairlines; no horizontal gutter or row gap.
    paddingVertical: 16,
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
    // Small centered card (Figma 992:9884 — 71x104) so the heart floats in the
    // empty top-right corner instead of overlapping the art.
    borderRadius: 6,
    height: 104,
    width: 71,
  },
  // Purple filled heart 6px from the cell's top-right corner (Figma 992:9898),
  // anchored to the tile so it sits clear of the small centered card.
  heartBadgeGrid: {
    position: 'absolute',
    right: 6,
    top: 6,
  },
  gridTextWrap: {
    gap: 4,
    paddingTop: 16,
  },
  gridMeta: {
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 12,
    lineHeight: 15.6,
  },
  gridPriceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    marginTop: 4,
  },
  gridPrice: {
    flexShrink: 1,
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 13,
    lineHeight: 18.2,
  },
  gridDeltaPill: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  gridDeltaLabel: {
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 11,
    lineHeight: 14.3,
  },
});

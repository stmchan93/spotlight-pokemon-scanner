import { useCallback, useEffect, useMemo, useState } from 'react';
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
  ArrowUp,
  Filter as FilterIcon,
  Heart,
  Menu as MenuIcon,
  Search as SearchIcon,
  Upload as ShareIcon,
} from 'iconoir-react-native';
import { IconLayoutGrid, IconList } from '@tabler/icons-react-native';
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

import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { saveCardDetailPreviewFromFavorite } from '@/features/cards/card-detail-preview-session';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAppServices } from '@/providers/app-providers';

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

  const handleEntryPress = useCallback((entry: CardFavoriteEntry) => {
    const previewId = saveCardDetailPreviewFromFavorite(entry);
    router.push({
      pathname: '/cards/[cardId]',
      params: {
        cardId: entry.cardId,
        previewId,
      },
    });
  }, [router]);

  const handleToggleViewMode = useCallback(() => {
    setViewMode(viewMode === 'list' ? 'grid' : 'list');
  }, [setViewMode, viewMode]);

  const toggleAccessibilityLabel =
    viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view';

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <ScrollView
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
        <View style={[styles.header, { paddingHorizontal: theme.layout.pageGutter }]}>
          <Pressable
            accessibilityLabel="Open menu"
            accessibilityRole="button"
            hitSlop={12}
            onPress={openDrawer}
            style={styles.headerIcon}
            testID="wishlist-header-menu"
          >
            <MenuIcon color={theme.colors.gray900} height={24} width={24} />
          </Pressable>
          <Text
            numberOfLines={1}
            style={[theme.typography.titleMedium, styles.headerTitle]}
            testID="wishlist-header-title"
          >
            Wishlist
          </Text>
          <Pressable
            accessibilityLabel="Share wishlist"
            accessibilityRole="button"
            hitSlop={12}
            style={styles.headerIcon}
            testID="wishlist-header-share"
          >
            <ShareIcon color={theme.colors.gray900} height={22} width={22} />
          </Pressable>
        </View>

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
              size={32}
              testID="wishlist-view-toggle"
              variant="elevated"
            >
              {viewMode === 'list' ? (
                <IconLayoutGrid color={theme.colors.gray900} size={18} />
              ) : (
                <IconList color={theme.colors.gray900} size={18} />
              )}
            </IconButton>
            <Pressable
              accessibilityLabel="Search"
              accessibilityRole="button"
              hitSlop={8}
              style={[
                styles.searchButton,
                { borderColor: theme.colors.gray300 },
              ]}
              testID="wishlist-search-button"
            >
              <SearchIcon color={theme.colors.gray900} height={16} width={16} />
            </Pressable>
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
            <WishlistListView entries={visibleEntries} onPressEntry={handleEntryPress} />
          ) : (
            <WishlistGridView entries={visibleEntries} onPressEntry={handleEntryPress} />
          )}
        </View>
      </ScrollView>

      <CollectionAddFab />
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
      {entries.map((entry) => (
        <View
          key={entry.cardId}
          style={styles.listRowWrap}
          testID={`wishlist-row-wrap-${entry.cardId}`}
        >
          <CardListRow
            cardNumber={entry.cardNumber}
            currencyCode={entry.currencyCode ?? 'USD'}
            gradeLabel={null}
            imageUrl={entry.smallImageUrl ?? entry.imageUrl ?? null}
            marketPrice={entry.marketPrice ?? null}
            name={entry.name}
            onPress={() => onPressEntry(entry)}
            quantity={1}
            setName={entry.setName}
            testID={`wishlist-row-${entry.cardId}`}
            trendChangeAmount={null}
          />
          <View
            pointerEvents="none"
            style={[styles.heartBadge, { backgroundColor: theme.colors.brand }]}
            testID={`wishlist-row-heart-${entry.cardId}`}
          >
            <Heart color={theme.colors.gray900} height={9} width={9} />
          </View>
          {entry.isOwned ? (
            <View
              pointerEvents="none"
              style={[
                styles.ownedPill,
                {
                  backgroundColor: theme.colors.gray100,
                  borderColor: theme.colors.gray300,
                },
              ]}
              testID={`wishlist-row-owned-${entry.cardId}`}
            >
              <Text
                style={[
                  theme.typography.label,
                  styles.ownedPillText,
                  { color: theme.colors.gray700 },
                ]}
              >
                In collection
              </Text>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function WishlistGridView({ entries, onPressEntry }: WishlistViewProps) {
  const theme = useSpotlightTheme();
  const leftColumn: CardFavoriteEntry[] = [];
  const rightColumn: CardFavoriteEntry[] = [];
  entries.forEach((entry, index) => {
    (index % 2 === 0 ? leftColumn : rightColumn).push(entry);
  });

  return (
    <View style={styles.gridContainer} testID="wishlist-grid">
      <View style={styles.gridColumn}>
        {leftColumn.map((entry) => (
          <WishlistGridTile
            entry={entry}
            key={entry.cardId}
            onPress={() => onPressEntry(entry)}
            theme={theme}
          />
        ))}
      </View>
      <View style={styles.gridColumn}>
        {rightColumn.map((entry) => (
          <WishlistGridTile
            entry={entry}
            key={entry.cardId}
            onPress={() => onPressEntry(entry)}
            theme={theme}
          />
        ))}
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
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.gridTile,
        {
          backgroundColor: theme.colors.canvasElevated,
          borderColor: theme.colors.outlineSubtle,
          opacity: pressed ? 0.84 : 1,
        },
      ]}
      testID={`wishlist-grid-tile-${entry.cardId}`}
    >
      <View
        style={[
          styles.gridImageWrap,
          { backgroundColor: theme.colors.field, borderColor: theme.colors.outlineSubtle },
        ]}
      >
        {imageUri ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: imageUri }}
            style={StyleSheet.absoluteFill}
            testID={`wishlist-grid-tile-${entry.cardId}-image`}
          />
        ) : null}
        <View
          style={[styles.heartBadgeGrid, { backgroundColor: theme.colors.brand }]}
          testID={`wishlist-grid-tile-${entry.cardId}-heart`}
        >
          <Heart color={theme.colors.gray900} height={10} width={10} />
        </View>
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
        <View style={styles.gridPriceRow}>
          <Text
            numberOfLines={1}
            style={[theme.typography.label, styles.gridPrice, { color: theme.colors.gray900 }]}
          >
            {formatOptionalCurrency(entry.marketPrice, entry.currencyCode)}
          </Text>
          {entry.isOwned ? (
            <Text
              numberOfLines={1}
              style={[styles.gridOwnedText, { color: theme.colors.gray600 }]}
            >
              In collection
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 16,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 40,
  },
  headerIcon: {
    alignItems: 'center',
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
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
  searchButton: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    width: 32,
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
    gap: 8,
    paddingHorizontal: 16,
  },
  listRowWrap: {
    position: 'relative',
  },
  heartBadge: {
    alignItems: 'center',
    borderRadius: 7,
    bottom: 14,
    height: 14,
    justifyContent: 'center',
    left: 60,
    position: 'absolute',
    width: 14,
  },
  ownedPill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    position: 'absolute',
    right: 14,
    top: 10,
  },
  ownedPillText: {
    fontSize: 10,
    lineHeight: 14,
  },
  gridContainer: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
  },
  gridColumn: {
    flex: 1,
    gap: 12,
  },
  gridTile: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    padding: 8,
  },
  gridImageWrap: {
    aspectRatio: 0.72,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  heartBadgeGrid: {
    alignItems: 'center',
    borderRadius: 8,
    bottom: 6,
    height: 16,
    justifyContent: 'center',
    position: 'absolute',
    right: 6,
    width: 16,
  },
  gridTextWrap: {
    gap: 4,
    paddingHorizontal: 2,
    paddingTop: 8,
  },
  gridMeta: {
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 12,
    lineHeight: 15.6,
  },
  gridPriceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  gridPrice: {
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 13,
    lineHeight: 18.2,
  },
  gridOwnedText: {
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 10,
    lineHeight: 14,
  },
});

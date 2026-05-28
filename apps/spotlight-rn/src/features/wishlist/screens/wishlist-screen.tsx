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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import type { CardFavoriteEntry } from '@spotlight/api-client';
import { SearchField, colors, useSpotlightTheme } from '@spotlight/design-system';

import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { saveCardDetailPreviewFromFavorite } from '@/features/cards/card-detail-preview-session';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAppServices } from '@/providers/app-providers';

type WishlistFilterKey = 'all' | 'az' | 'price' | 'owned' | 'unowned';

const FILTERS: readonly { key: WishlistFilterKey; label: string; hasArrow?: boolean }[] = [
  { key: 'all', label: 'All' },
  { key: 'az', label: 'A-Z' },
  { key: 'price', label: 'Price', hasArrow: true },
  { key: 'unowned', label: 'Unowned' },
  { key: 'owned', label: 'Owned' },
];

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

        <View style={styles.list} testID="wishlist-list">
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
          ) : (
            visibleEntries.map((entry) => (
              <Pressable
                accessibilityRole="button"
                key={entry.cardId}
                onPress={() => handleEntryPress(entry)}
                style={({ pressed }) => [
                  styles.row,
                  { borderTopColor: theme.colors.gray100, borderBottomColor: theme.colors.gray100 },
                  pressed ? styles.rowPressed : null,
                ]}
                testID={`wishlist-row-${entry.cardId}`}
              >
                <View style={styles.rowLeft}>
                  <View style={styles.thumbWrap}>
                    {entry.imageUrl ? (
                      <Image source={{ uri: entry.imageUrl }} style={styles.thumb} />
                    ) : (
                      <View style={[styles.thumb, { backgroundColor: theme.colors.gray100 }]} />
                    )}
                    <View
                      style={[
                        styles.heartBadge,
                        { backgroundColor: theme.colors.brand },
                      ]}
                    >
                      <Heart color={theme.colors.gray900} height={9} width={9} />
                    </View>
                  </View>

                  <View style={styles.rowText}>
                    <Text
                      numberOfLines={1}
                      style={[theme.typography.bodyMedium, { color: theme.colors.gray900, fontWeight: '600' }]}
                    >
                      {entry.name}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[styles.metaText, { color: theme.colors.gray600 }]}
                    >
                      {entry.cardNumber}
                      {entry.cardNumber && entry.setName ? '  ·  ' : ''}
                      {entry.setName}
                    </Text>
                    {entry.isOwned ? (
                      <Text
                        numberOfLines={1}
                        style={[styles.metaText, styles.conditionText, { color: theme.colors.gray600 }]}
                      >
                        In your collection
                      </Text>
                    ) : null}
                  </View>
                </View>

                <View style={styles.rowRight}>
                  <Text
                    numberOfLines={1}
                    style={[theme.typography.label, styles.priceText, { color: theme.colors.gray900 }]}
                  >
                    {formatOptionalCurrency(entry.marketPrice, entry.currencyCode)}
                  </Text>
                </View>
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>

      <CollectionAddFab />
    </SafeAreaView>
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
  list: {
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
  row: {
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderTopWidth: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowPressed: {
    opacity: 0.78,
  },
  rowLeft: {
    flexDirection: 'row',
    flex: 1,
    gap: 12,
  },
  thumbWrap: {
    height: 78,
    position: 'relative',
    width: 54,
  },
  thumb: {
    borderRadius: 2,
    height: 78,
    width: 54,
  },
  heartBadge: {
    alignItems: 'center',
    borderRadius: 7,
    bottom: 4,
    height: 14,
    justifyContent: 'center',
    position: 'absolute',
    right: 4,
    width: 14,
  },
  rowText: {
    flex: 1,
    gap: 5,
    justifyContent: 'space-between',
  },
  metaText: {
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 12,
    lineHeight: 15.6,
  },
  conditionText: {
    marginTop: 8,
  },
  rowRight: {
    alignItems: 'flex-end',
    gap: 3,
    minWidth: 80,
  },
  priceText: {
    fontFamily: 'SpotlightBodySemiBold',
    fontSize: 13,
    lineHeight: 18.2,
  },
});

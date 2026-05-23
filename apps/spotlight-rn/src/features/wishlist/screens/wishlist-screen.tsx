import { useCallback, useMemo, useState } from 'react';
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

import { SearchField, colors, useSpotlightTheme } from '@spotlight/design-system';

import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { useAppDrawer } from '@/providers/app-drawer-provider';

type WishlistFilterKey = 'all' | 'az' | 'price' | 'ungraded' | 'graded';

const FILTERS: ReadonlyArray<{ key: WishlistFilterKey; label: string; hasArrow?: boolean }> = [
  { key: 'all', label: 'All' },
  { key: 'az', label: 'A-Z' },
  { key: 'price', label: 'Price', hasArrow: true },
  { key: 'ungraded', label: 'Ungraded' },
  { key: 'graded', label: 'Graded' },
];

type WishlistEntry = {
  id: string;
  name: string;
  cardNumber: string;
  setName: string;
  condition: string;
  price: string;
  delta: string;
  qty: number;
  imageUri: string | null;
};

// Placeholder rows so the screen matches the Figma. Real wishlist persistence
// is not built yet — when it lands this list comes from the backend.
const SAMPLE_ENTRIES: ReadonlyArray<WishlistEntry> = [
  {
    id: '1',
    name: 'Charizard',
    cardNumber: '100/101',
    setName: 'Dragon Frontiers',
    condition: 'PSA 10',
    price: '$129,198.30',
    delta: '$3.99',
    qty: 1,
    imageUri: null,
  },
  {
    id: '2',
    name: 'Gengar ex',
    cardNumber: '193/162',
    setName: 'Perfect Order',
    condition: 'Near Mint',
    price: '$450.12',
    delta: '$3.99',
    qty: 1,
    imageUri: null,
  },
  {
    id: '3',
    name: 'Poncho-Wearing Pikachu',
    cardNumber: '193/162',
    setName: 'Perfect Order',
    condition: 'PSA 10',
    price: '$16,499.12',
    delta: '$3.99',
    qty: 1,
    imageUri: null,
  },
  {
    id: '4',
    name: 'Charizard',
    cardNumber: '100/101',
    setName: 'Dragon Frontiers',
    condition: 'PSA 10',
    price: '$129,198.30',
    delta: '$3.99',
    qty: 1,
    imageUri: null,
  },
  {
    id: '5',
    name: 'Gengar ex',
    cardNumber: '193/162',
    setName: 'Perfect Order',
    condition: 'Near Mint',
    price: '$450.12',
    delta: '$3.99',
    qty: 1,
    imageUri: null,
  },
  {
    id: '6',
    name: 'Poncho-Wearing Pikachu',
    cardNumber: '193/162',
    setName: 'Perfect Order',
    condition: 'PSA 10',
    price: '$16,499.12',
    delta: '$3.99',
    qty: 1,
    imageUri: null,
  },
];

export function WishlistScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { openDrawer } = useAppDrawer();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<WishlistFilterKey>('all');

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    setIsRefreshing(false);
  }, []);

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      return SAMPLE_ENTRIES;
    }
    return SAMPLE_ENTRIES.filter((entry) =>
      [entry.name, entry.cardNumber, entry.setName, entry.condition]
        .join(' ')
        .toLowerCase()
        .includes(normalized),
    );
  }, [query]);

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

        <View style={styles.list}>
          {filteredEntries.map((entry) => (
            <View
              key={entry.id}
              style={[
                styles.row,
                { borderTopColor: theme.colors.gray100, borderBottomColor: theme.colors.gray100 },
              ]}
              testID={`wishlist-row-${entry.id}`}
            >
              <View style={styles.rowLeft}>
                <View style={styles.thumbWrap}>
                  {entry.imageUri ? (
                    <Image source={{ uri: entry.imageUri }} style={styles.thumb} />
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
                    {'  ·  '}
                    {entry.setName}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[styles.metaText, styles.conditionText, { color: theme.colors.gray600 }]}
                  >
                    {entry.condition}
                  </Text>
                </View>
              </View>

              <View style={styles.rowRight}>
                <Text
                  numberOfLines={1}
                  style={[theme.typography.label, styles.priceText, { color: theme.colors.gray900 }]}
                >
                  {entry.price}
                </Text>
                <View style={[styles.deltaPill, { backgroundColor: theme.colors.green100 }]}>
                  <ArrowUp color={theme.colors.green400} height={11} strokeWidth={2} width={11} />
                  <Text
                    style={[styles.deltaText, { color: theme.colors.green400 }]}
                  >
                    {entry.delta}
                  </Text>
                </View>
                <Text
                  numberOfLines={1}
                  style={[styles.qtyText, { color: theme.colors.gray600 }]}
                >
                  Qty: {entry.qty}
                </Text>
              </View>
            </View>
          ))}
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
  row: {
    alignItems: 'flex-start',
    borderBottomWidth: 1,
    borderTopWidth: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
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
  deltaPill: {
    alignItems: 'center',
    borderRadius: 4,
    flexDirection: 'row',
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  deltaText: {
    fontFamily: 'SpotlightBodyMedium',
    fontSize: 11,
    lineHeight: 14.3,
  },
  qtyText: {
    fontFamily: 'SpotlightBodyRegular',
    fontSize: 12,
    lineHeight: 15.6,
    marginTop: 18,
  },
});

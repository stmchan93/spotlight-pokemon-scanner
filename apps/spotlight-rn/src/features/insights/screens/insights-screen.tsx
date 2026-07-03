import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Filter, NavArrowLeft, ShareIos } from 'iconoir-react-native';

import type { PortfolioPerformance, PortfolioPerformanceRow } from '@spotlight/api-client';
import { IconButton, SearchField, colors, textStyles, useSpotlightTheme } from '@spotlight/design-system';

import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useAppServices } from '@/providers/app-providers';
import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';
import { ScrollToTopFab, useScrollToTop } from '@/components/scroll-to-top-fab';
import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import {
  InsightsFilterChipRow,
  type InsightsFilterKey,
} from '@/features/insights/components/insights-filter-chip-row';
import {
  InsightsSortSheet,
  type InsightsSortKey,
} from '@/features/insights/components/insights-sort-sheet';
import {
  PerformanceTable,
  PerformanceTableSkeleton,
  PortfolioTag,
  allTimeGrowthPercent,
} from '@/features/insights/components/performance-table';

// Chip semantics mirror the Collection screen's applyCollectionFilter, mapped
// onto performance rows: Likes/Ungraded/Graded filter, Price/A-Z re-sort, All
// keeps the backend order (recently added first).
export function applyInsightsFilter(
  rows: PortfolioPerformanceRow[],
  filter: InsightsFilterKey,
): PortfolioPerformanceRow[] {
  switch (filter) {
    case 'favorites':
      return rows.filter((row) => row.isFavorite);
    case 'price':
      return [...rows].sort(
        (a, b) => (b.currentPrice ?? -Infinity) - (a.currentPrice ?? -Infinity),
      );
    case 'az':
      return [...rows].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      );
    case 'ungraded':
      return rows.filter((row) => row.kind !== 'graded');
    case 'graded':
      return rows.filter((row) => row.kind === 'graded');
    default:
      return rows;
  }
}

export function applyInsightsSearch(
  rows: PortfolioPerformanceRow[],
  query: string,
): PortfolioPerformanceRow[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return rows;
  }
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(normalized)
      || row.cardNumber.toLowerCase().includes(normalized)
      || row.setName.toLowerCase().includes(normalized),
  );
}

// "Filter By" sheet sorts. Nulls (no price / no cost basis / no history) sink
// to the bottom in every order so sparse rows never crowd the top.
export function applyInsightsSort(
  rows: PortfolioPerformanceRow[],
  sortKey: InsightsSortKey,
): PortfolioPerformanceRow[] {
  const desc = (select: (row: PortfolioPerformanceRow) => number | null) =>
    (a: PortfolioPerformanceRow, b: PortfolioPerformanceRow) =>
      (select(b) ?? -Infinity) - (select(a) ?? -Infinity);
  const asc = (select: (row: PortfolioPerformanceRow) => number | null) =>
    (a: PortfolioPerformanceRow, b: PortfolioPerformanceRow) =>
      (select(a) ?? Infinity) - (select(b) ?? Infinity);

  switch (sortKey) {
    case 'most-valuable':
      return [...rows].sort(desc((row) => row.currentValue));
    case 'least-valuable':
      return [...rows].sort(asc((row) => row.currentValue));
    case 'winners-month':
      return [...rows].sort(desc((row) => row.monthGainDollar));
    case 'losers-month':
      return [...rows].sort(asc((row) => row.monthGainDollar));
    case 'all-time-growth':
      return [...rows].sort(desc(allTimeGrowthPercent));
    case 'most-spent':
      return [...rows].sort(desc((row) => row.costBasisTotal));
    default:
      return rows;
  }
}

/**
 * Insights (Figma 2206-20251): the per-card performance tracker. A "Pokemon"
 * category header, collection search, filter chips, and a "Filter By" sort
 * sheet sit above the virtualized performance table (Chart/Current/month G/L/
 * totals/cost pan horizontally; rows scroll vertically under a pinned column
 * header). All filtering/sorting is client-side over the one batched
 * performance read. The last successful read is cached in AppServices so a
 * revisit paints instantly instead of flashing an empty state.
 */
export function InsightsScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const handleTabBarScroll = useTabBarScrollHandler();
  const {
    spotlightRepository,
    dataVersion,
    portfolioPerformanceCache,
    setPortfolioPerformanceCache,
  } = useAppServices();

  const [performance, setPerformance] = useState<PortfolioPerformance | null>(
    portfolioPerformanceCache,
  );
  // Distinguishes "still loading (show spinner)" from "loaded, genuinely empty
  // (show empty copy)". Seeded true when a cached read is already available.
  const [hasLoaded, setHasLoaded] = useState(portfolioPerformanceCache != null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<InsightsFilterKey>('all');
  const [sortKey, setSortKey] = useState<InsightsSortKey>('default');
  const [sortSheetVisible, setSortSheetVisible] = useState(false);

  const listRef = useRef<FlatList<PortfolioPerformanceRow>>(null);
  const { isVisible: showScrollTop, handleScroll, handleLayout, scrollToTop } = useScrollToTop(
    listRef,
    handleTabBarScroll,
  );

  const load = useCallback(async () => {
    try {
      const result = await spotlightRepository.getPortfolioPerformance();
      setPerformance(result);
      setPortfolioPerformanceCache(result);
      setHasLoaded(true);
    } catch {
      // Keep the last value (cached rows stay visible); the refresh control +
      // next focus will retry. Don't flip hasLoaded — a failed fetch must not be
      // read as "genuinely empty".
    }
  }, [setPortfolioPerformanceCache, spotlightRepository]);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }, [load]);

  const handleBack = useCallback(() => {
    router.back();
  }, [router]);

  const handleShare = useCallback(() => {
    void Share.share({ message: 'My Ekalight insights' });
  }, []);

  const handleApplySort = useCallback((next: InsightsSortKey) => {
    setSortKey(next);
    setSortSheetVisible(false);
  }, []);

  const handleSelectRow = useCallback(
    (row: PortfolioPerformanceRow) => {
      prefetchCardDetail(spotlightRepository, row.cardId, undefined, row.imageUrl);
      const previewId = saveCardDetailPreviewFromCatalogResult({
        id: row.entryId,
        cardId: row.cardId,
        name: row.name,
        cardNumber: row.cardNumber,
        setName: row.setName,
        imageUrl: row.imageUrl ?? '',
        marketPrice: row.currentPrice,
        currencyCode: performance?.currencyCode ?? 'USD',
      });
      router.push({
        pathname: '/cards/[cardId]',
        // Pass the specific deck-entry id so the PDP opens THIS holding (right
        // condition/quantity) — without it the PDP falls back to the first owned
        // entry for the card, so two Gastly holdings (LP vs NM) both opened the LP.
        params: { cardId: row.cardId, entryId: row.entryId, previewId },
      });
    },
    [performance?.currencyCode, router, spotlightRepository],
  );

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const rows = useMemo(
    () =>
      applyInsightsSort(
        applyInsightsSearch(
          applyInsightsFilter(performance?.rows ?? [], activeFilter),
          searchQuery,
        ),
        sortKey,
      ),
    [performance, activeFilter, searchQuery, sortKey],
  );
  const currencyCode = performance?.currencyCode ?? 'USD';
  const itemCount = rows.length;
  const isFiltered = searchQuery.trim().length > 0 || activeFilter !== 'all';

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <View
        style={[
          styles.headerRow,
          {
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
      >
        <Pressable
          accessibilityLabel="Go back"
          accessibilityRole="button"
          hitSlop={12}
          onPress={handleBack}
          style={styles.headerButton}
          testID="insights-header-back"
        >
          <NavArrowLeft color={colors.gray900} height={24} width={24} />
        </Pressable>
        <Text style={styles.headerTitle} testID="insights-header-title">
          Insights
        </Text>
        <Pressable
          accessibilityLabel="Share insights"
          accessibilityRole="button"
          hitSlop={12}
          onPress={handleShare}
          style={styles.headerButton}
          testID="insights-header-share"
        >
          <ShareIos color={colors.gray900} height={20} width={20} />
        </Pressable>
      </View>

      <View style={styles.pageBody}>
        {/* Refresh indicator: an ABSOLUTE overlay pinned to the very top of the
            page (in the empty center of the Pokemon row, between the Insights
            header and the "Pokemon" title) rather than an inline row. Inline it
            reflowed the whole page — pushing the table and its column headers
            down ~48px on every pull — so the spinner read as mid-page and the
            chart headers weren't static. Overlaying it keeps the headers fixed
            and puts the spinner up top. */}
        {isRefreshing ? (
          <View pointerEvents="none" style={styles.refreshingOverlay} testID="insights-refreshing">
            <ActivityIndicator color={colors.gray400} />
          </View>
        ) : null}

        {/* Category header — chevron intentionally omitted per the Figma
            annotation until more TCG categories exist. */}
        <View style={[styles.categoryRow, styles.gutter]}>
          <Text
            style={[theme.typography.titleMedium, { color: theme.colors.gray900 }]}
            testID="insights-category-title"
          >
            Pokemon
          </Text>
          <Text style={[theme.typography.label, { color: theme.colors.gray500 }]}>
            {`${itemCount} Item${itemCount === 1 ? '' : 's'}`}
          </Text>
        </View>

        <View style={styles.searchGroup}>
          <View style={[styles.searchRow, styles.gutter]}>
            <View style={styles.searchSlot}>
              <SearchField
                accessibilityLabel="Search your collection"
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                containerTestID="insights-search-input"
                onChangeText={setSearchQuery}
                placeholder="Search your collection"
                returnKeyType="search"
                size="collection"
                surface="muted"
                value={searchQuery}
              />
            </View>
            <IconButton
              accessibilityLabel="Sort options"
              onPress={() => setSortSheetVisible(true)}
              shape="rounded"
              size={40}
              testID="insights-sort-button"
              variant="outlined"
            >
              <Filter color={colors.gray900} height={18} width={18} />
            </IconButton>
          </View>
          <InsightsFilterChipRow
            activeFilter={activeFilter}
            onFilterChange={setActiveFilter}
            testID="insights-filter-chip-row"
          />
        </View>

        {/* The PORTFOLIO tag renders inside the table's pinned header row so it
            left-aligns with the card column and shares the row with the metric
            labels (Figma 2179-8996/2179-9032). */}
        <View style={styles.tableSection}>
          {rows.length > 0 ? (
            <PerformanceTable
              ref={listRef}
              rows={rows}
              currencyCode={currencyCode}
              onSelectRow={handleSelectRow}
              onScroll={handleScroll}
              onLayout={handleLayout}
              contentInsetBottom={bottomNavClearance + 16}
              refreshControl={
                // The table's list is WIDER than the screen (it pans
                // horizontally), so the native spinner centered on it lands at
                // the top-right. Keep the pull gesture but hide the native
                // spinner; the page shows its own indicator under the header.
                <RefreshControl
                  onRefresh={handleRefresh}
                  refreshing={isRefreshing}
                  tintColor="transparent"
                />
              }
            />
          ) : hasLoaded ? (
            <>
              <PortfolioTag />
              <Text
                style={[theme.typography.body, styles.emptyText, { color: theme.colors.gray500 }]}
                testID="insights-empty"
              >
                {isFiltered
                  ? 'No cards match your search.'
                  : 'No cards in your portfolio yet.'}
              </Text>
            </>
          ) : (
            // Query still in flight — show skeleton rows, never the empty state.
            <PerformanceTableSkeleton testID="insights-loading-skeleton" />
          )}
        </View>
      </View>

      <InsightsSortSheet
        onApply={handleApplySort}
        onClose={() => setSortSheetVisible(false)}
        sortKey={sortKey}
        visible={sortSheetVisible}
      />

      <ScrollToTopFab onPress={scrollToTop} testID="insights-scroll-to-top" visible={showScrollTop} />
      <CollectionAddFab />

      <AppBottomTabBar activeKey="portfolio" dismissToTabs />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  refreshingOverlay: {
    alignItems: 'center',
    // Pinned to the top of the page body — sits in the empty center of the
    // Pokemon row (title left, item-count right) so it never reflows the table
    // below. zIndex keeps it above the category row.
    left: 0,
    position: 'absolute',
    right: 0,
    top: 8,
    zIndex: 5,
  },
  safeArea: {
    flex: 1,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerButton: {
    alignItems: 'center',
    backgroundColor: colors.gray50,
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  headerTitle: {
    ...textStyles.titleMedium,
    color: colors.gray900,
    flex: 1,
    textAlign: 'center',
  },
  pageBody: {
    flex: 1,
    gap: 16,
    paddingTop: 16,
  },
  gutter: {
    paddingHorizontal: 16,
  },
  categoryRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  searchGroup: {
    gap: 12,
  },
  searchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  searchSlot: {
    flex: 1,
  },
  tableSection: {
    flex: 1,
    gap: 16,
    paddingLeft: 16,
    // pageBody's gap (16) + this = the 32px between the filter chips and the
    // PORTFOLIO/column-header row (Figma 2179-8996).
    paddingTop: 16,
  },
  emptyText: {
    paddingRight: 16,
    paddingVertical: 48,
    textAlign: 'center',
  },
});

export default InsightsScreen;

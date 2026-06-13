import { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Menu as MenuIcon } from 'iconoir-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { StateCard, useSpotlightTheme } from '@spotlight/design-system';

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
import { ScrollToTopFab, useScrollToTop } from '@/components/scroll-to-top-fab';
import { usePortfolioScreenModel } from '@/features/portfolio/hooks/use-portfolio-screen-model';
import { usePortfolioViewMode } from '@/features/portfolio/hooks/use-portfolio-view-mode';
import { usePortfolioSummaryVisibility } from '@/features/portfolio/use-portfolio-summary-visibility';
import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useAppDrawer } from '@/providers/app-drawer-provider';

const GRID_TEST_ID = 'collection-masonry-grid';

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

function applyCollectionFilter(
  items: InventoryCardEntry[],
  filter: CollectionFilterKey,
): InventoryCardEntry[] {
  switch (filter) {
    case 'all':
      return items;
    case 'az':
      return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    case 'price':
      return [...items].sort((a, b) => {
        const ap = a.hasMarketPrice ? a.marketPrice : -Infinity;
        const bp = b.hasMarketPrice ? b.marketPrice : -Infinity;
        return bp - ap;
      });
    case 'favorites':
      return items.filter((entry) => entry.isFavorite === true);
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
  const { isHidden: isSummaryHidden, toggle: toggleSummaryHidden } = usePortfolioSummaryVisibility();
  const { viewMode, toggleViewMode } = usePortfolioViewMode();
  const { openDrawer } = useAppDrawer();
  const handleTabBarScroll = useTabBarScrollHandler();
  const [activeChartPoint, setActiveChartPoint] = useState<PortfolioChartActivePoint | null>(null);
  const [isChartScrubbing, setIsChartScrubbing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<CollectionFilterKey>('all');
  const scrollRef = useRef<FlatList<CollectionRow>>(null);

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
    const filtered = applyCollectionFilter(baseInventory, activeFilter);
    return applyInventorySearch(filtered, model.searchQuery);
  }, [activeFilter, baseInventory, model.searchQuery]);

  const {
    isVisible: showScrollTop,
    handleScroll,
    handleLayout,
    scrollToTop,
  } = useScrollToTop(scrollRef, handleTabBarScroll);

  const handlePressEntry = useCallback(
    (entry: InventoryCardEntry) => {
      onOpenInventoryEntry(entry);
    },
    [onOpenInventoryEntry],
  );

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
            entry={item.entry}
            firstInSection={item.firstInSection}
            onPress={handlePressEntry}
          />
        );
      }
      if (item.kind === 'grid-single') {
        return (
          <CollectionGridSingleRow
            entry={item.entry}
            onPressEntry={handlePressEntry}
            testID={GRID_TEST_ID}
          />
        );
      }
      return (
        <CollectionGridRow
          isFirstRow={item.rowIndex === 0}
          onPressEntry={handlePressEntry}
          rowEntries={item.rowEntries}
          rowIndex={item.rowIndex}
          testID={GRID_TEST_ID}
        />
      );
    },
    [handlePressEntry],
  );

  const listHeader = (
    <View style={styles.chrome}>
      <View style={[styles.header, { paddingHorizontal: theme.layout.pageGutter }]}>
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
        <View style={styles.headerSpacer} />
      </View>

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
            activeChartPoint={activeChartPoint}
            isSummaryHidden={isSummaryHidden}
            onToggleHidden={toggleSummaryHidden}
          />

          <View style={styles.chartWrap}>
            <PortfolioChartCard
              chartMode="portfolio"
              dashboard={model.dashboard}
              isLoading={model.isLoadingDashboard && !model.hasLoadedDashboard}
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

          <CollectionSearchRow
            onChangeQuery={model.setSearchQuery}
            onToggleViewMode={toggleViewMode}
            query={model.searchQuery}
            viewMode={viewMode}
          />

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

      <CollectionAddFab />

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
    flexDirection: 'row',
    height: 40,
  },
  headerIcon: {
    height: 24,
    width: 24,
  },
  headerSpacer: {
    height: 24,
    width: 24,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
  },
  listWrap: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
});

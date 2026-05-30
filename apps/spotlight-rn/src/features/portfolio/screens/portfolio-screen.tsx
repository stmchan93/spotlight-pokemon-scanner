import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Menu as MenuIcon } from 'iconoir-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry } from '@spotlight/api-client';
import {
  ListPaginationFooter,
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

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
import { CollectionMasonryGrid } from '@/features/portfolio/components/collection-masonry-grid';
import { CollectionListView } from '@/features/portfolio/components/collection-list-view';
import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { usePortfolioScreenModel } from '@/features/portfolio/hooks/use-portfolio-screen-model';
import { usePortfolioViewMode } from '@/features/portfolio/hooks/use-portfolio-view-mode';
import { usePortfolioSummaryVisibility } from '@/features/portfolio/use-portfolio-summary-visibility';
import { useAppDrawer } from '@/providers/app-drawer-provider';

const LIST_PAGE_SIZE = 10;

type PortfolioScreenProps = {
  onOpenInventoryEntry?: (entry: InventoryCardEntry) => void;
};

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
  const [activeChartPoint, setActiveChartPoint] = useState<PortfolioChartActivePoint | null>(null);
  const [isChartScrubbing, setIsChartScrubbing] = useState(false);
  const [activeFilter, setActiveFilter] = useState<CollectionFilterKey>('all');
  const scrollRef = useRef<ScrollView>(null);
  const [listVisibleCount, setListVisibleCount] = useState(LIST_PAGE_SIZE);

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

  useEffect(() => {
    setListVisibleCount(LIST_PAGE_SIZE);
  }, [activeFilter, model.searchQuery, viewMode]);

  const handleBackToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

  const handlePressEntry = useCallback(
    (entry: InventoryCardEntry) => {
      onOpenInventoryEntry(entry);
    },
    [onOpenInventoryEntry],
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
    >
      <ScrollView
        ref={scrollRef}
        testID="portfolio-scroll-view"
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: bottomNavClearance,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
        refreshControl={(
          <RefreshControl
            onRefresh={model.refresh}
            refreshing={model.isRefreshing}
            testID="portfolio-refresh-control"
            tintColor={theme.colors.gray400}
          />
        )}
        scrollEnabled={!isChartScrubbing}
      >
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

            {visibleInventory.length > 0 ? (
              viewMode === 'list' ? (
                <CollectionListView
                  entries={visibleInventory.slice(0, listVisibleCount)}
                  onPressEntry={handlePressEntry}
                />
              ) : (
                <CollectionMasonryGrid
                  entries={visibleInventory.slice(0, listVisibleCount)}
                  onPressEntry={handlePressEntry}
                />
              )
            ) : (
              <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
                <StateCard
                  message="Add cards from the scanner or tap the + button to start your collection."
                  style={styles.emptyStateCard}
                  title="No cards match this filter"
                />
              </View>
            )}

            {visibleInventory.length > 0 ? (
              <ListPaginationFooter
                canViewMore={visibleInventory.length > listVisibleCount}
                onBackToTop={handleBackToTop}
                onViewMore={() => setListVisibleCount((count) => count + LIST_PAGE_SIZE)}
                testID="portfolio-list-pagination"
              />
            ) : (
              <Text
                style={[theme.typography.captionMedium, styles.endOfList, { color: theme.colors.gray600 }]}
                testID="portfolio-end-of-list"
              >
                End of List
              </Text>
            )}
          </>
        )}
      </ScrollView>

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
    // Container. The ScrollView `content` style adds a 16px gap between
    // children, so we add 48 here to land at exactly 64.
    marginTop: 48,
    marginBottom: 16,
  },
  content: {
    gap: 16,
  },
  emptyStateCard: {
    marginTop: 12,
  },
  endOfList: {
    marginTop: 24,
    textAlign: 'center',
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
  safeArea: {
    flex: 1,
  },
});

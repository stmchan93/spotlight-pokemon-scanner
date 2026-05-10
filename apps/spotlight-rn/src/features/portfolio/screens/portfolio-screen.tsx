import { useCallback, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Filter, MoreHoriz } from 'iconoir-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ChartMode, InventoryCardEntry } from '@spotlight/api-client';
import {
  InventoryCardTile,
  PageTabs,
  SearchField,
  SectionHeader,
  StateCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import {
  PortfolioChartCard,
  type PortfolioChartActivePoint,
} from '@/features/portfolio/components/portfolio-chart-card';
import { RecentSalesSection } from '@/features/portfolio/components/recent-sales-section';
import { SalePriceEditSheet } from '@/features/portfolio/components/sale-price-edit-sheet';
import {
  formatCurrency,
  formatOptionalCurrency,
  formatPercent,
  formatSignedCurrency,
} from '@/features/portfolio/components/portfolio-formatting';
import { usePortfolioScreenModel } from '@/features/portfolio/hooks/use-portfolio-screen-model';
import { getCardImageUrl } from '@/lib/card-images';

type PortfolioScreenProps = {
  accountInitials?: string;
  onOpenAccount?: () => void;
  onOpenInventory?: () => void;
  onOpenInventoryEntry?: (entry: InventoryCardEntry) => void;
  /**
   * Wired to the View All link inside the Recent Sales tab — navigates
   * to the full-screen virtualized sales list at /sales.
   */
  onOpenSalesHistory?: () => void;
};

type InventoryTypeFilter = 'all' | 'raw' | 'graded';
type CollectionTab = 'portfolio' | 'recent-sales' | 'favorites';

const inventoryHighlightLimit = 6;

function applyTypeFilter(items: InventoryCardEntry[], filter: InventoryTypeFilter) {
  if (filter === 'all') {
    return items;
  }
  if (filter === 'raw') {
    return items.filter((item) => item.kind === 'raw');
  }
  return items.filter((item) => item.kind === 'graded');
}

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

function sortByMarketPriceDesc(items: InventoryCardEntry[]) {
  return [...items].sort((a, b) => {
    const ap = a.hasMarketPrice ? a.marketPrice : -Infinity;
    const bp = b.hasMarketPrice ? b.marketPrice : -Infinity;
    return bp - ap;
  });
}

const inventoryTypeFilterOptions: ReadonlyArray<{ value: InventoryTypeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'raw', label: 'Raw' },
  { value: 'graded', label: 'Graded' },
];

const chartModeOptions: ReadonlyArray<{ value: ChartMode; label: string }> = [
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'sales', label: 'Sales' },
];

const collectionTabs = [
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'recent-sales', label: 'Recent Sales' },
  { value: 'favorites', label: 'Favorites' },
] as const satisfies ReadonlyArray<{ value: CollectionTab; label: string }>;

const recentSalesTabLimit = 6;

export function PortfolioScreen({
  accountInitials = 'AC',
  onOpenAccount = () => {},
  onOpenInventory = () => {},
  onOpenInventoryEntry = () => {},
  onOpenSalesHistory,
}: PortfolioScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const model = usePortfolioScreenModel();
  const [activeChartPoint, setActiveChartPoint] = useState<PortfolioChartActivePoint | null>(null);
  const [chartModeMenuOpen, setChartModeMenuOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<InventoryTypeFilter>('all');
  const [typeFilterMenuOpen, setTypeFilterMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CollectionTab>('portfolio');

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const shouldShowInitialError = !model.hasLoadedDashboard
    && !model.hasLoadedInventory
    && !model.isLoading
    && model.loadError !== null;

  const summary = model.dashboard.summary;
  const summaryValueLabel = activeChartPoint?.valueLabel
    ?? formatCurrency(summary.currentValue);
  const summaryDateLabel = activeChartPoint?.dateLabel ?? 'Today';
  const summaryDeltaLabel = activeChartPoint
    ? `${activeChartPoint.changeAmountLabel} (${activeChartPoint.changePercentLabel})`
    : `${formatSignedCurrency(summary.changeAmount)} (${formatPercent(summary.changePercent)})`;
  const summaryDeltaIsPositive = activeChartPoint
    ? activeChartPoint.changeAmount >= 0
    : summary.changeAmount >= 0;

  const baseInventory = model.dashboard.inventoryItems;

  const portfolioTabHighlights = useMemo(() => {
    const filtered = applyTypeFilter(baseInventory, typeFilter);
    const searched = applyInventorySearch(filtered, model.searchQuery);
    return sortByMarketPriceDesc(searched).slice(0, inventoryHighlightLimit);
  }, [baseInventory, model.searchQuery, typeFilter]);

  const favoritesTabItems = useMemo(() => {
    const favoritesOnly = baseInventory.filter((item) => item.isFavorite === true);
    const searched = applyInventorySearch(favoritesOnly, model.searchQuery);
    return sortByMarketPriceDesc(searched);
  }, [baseInventory, model.searchQuery]);

  const handleSelectTypeFilter = useCallback((filter: InventoryTypeFilter) => {
    setTypeFilter(filter);
    setTypeFilterMenuOpen(false);
  }, []);

  const handleSelectChartMode = useCallback((mode: ChartMode) => {
    model.setChartMode(mode);
    setChartModeMenuOpen(false);
  }, [model]);

  const filterTriggerIcon = useMemo(() => (
    <Pressable
      hitSlop={8}
      onPress={() => setTypeFilterMenuOpen(true)}
      style={styles.filterIconPressable}
      testID="portfolio-inventory-filter-trigger"
    >
      <Filter color={theme.colors.textSecondary} height={16} width={16} />
    </Pressable>
  ), [theme.colors.textSecondary]);

  const renderInventoryTile = useCallback((entry: InventoryCardEntry) => {
    const tileKind = entry.kind === 'graded' ? 'slab' : 'raw';
    const dayDelta = entry.dayChangeAmount ?? null;
    const hasDelta = dayDelta != null && dayDelta !== 0;
    const dayChangeLabel = hasDelta
      ? formatCurrency(Math.abs(dayDelta), entry.currencyCode)
      : null;
    const dayChangeDirection = hasDelta ? (dayDelta > 0 ? 'up' : 'down') : null;

    return (
      <View key={entry.id} style={styles.inventoryTileWrap}>
        <InventoryCardTile
          imageUrl={getCardImageUrl(entry, 'small')}
          name={entry.name}
          setName={entry.setName ?? ''}
          cardNumber={entry.cardNumber ?? null}
          kind={tileKind}
          conditionLabel={tileKind === 'raw' ? entry.conditionLabel ?? null : null}
          graderLabel={tileKind === 'slab' ? entry.slabContext?.grader ?? null : null}
          gradeLabel={tileKind === 'slab' ? entry.slabContext?.grade ?? null : null}
          quantity={entry.quantity}
          priceLabel={entry.hasMarketPrice ? formatOptionalCurrency(entry.marketPrice, entry.currencyCode) : null}
          dayChangeLabel={dayChangeLabel}
          dayChangeDirection={dayChangeDirection}
          isFavorite={entry.isFavorite === true}
          onPress={() => onOpenInventoryEntry(entry)}
          testID={`portfolio-inventory-tile-${entry.id}`}
        />
      </View>
    );
  }, [onOpenInventoryEntry]);

  const renderPortfolioTab = () => (
    <View style={styles.tabContent}>
      <SectionHeader
        actionLabel="View All"
        actionTestID="portfolio-inventory-view-all"
        expanded
        onActionPress={onOpenInventory}
        title="Collection"
      />

      <SearchField
        onChangeText={model.setSearchQuery}
        placeholder="Search inventory"
        size="compact"
        testID="portfolio-inventory-search"
        trailing={filterTriggerIcon}
        value={model.searchQuery}
      />

      {model.hasInventoryEntries ? (
        <View style={styles.inventoryGrid}>
          {portfolioTabHighlights.map(renderInventoryTile)}
        </View>
      ) : (
        <StateCard
          message="Add cards from the scanner to see your highest-value picks here."
          style={styles.emptyStateCard}
          title="No cards in your collection yet"
        />
      )}
    </View>
  );

  const recentSalesTabItems = model.recentSales.slice(0, recentSalesTabLimit);

  const renderRecentSalesTab = () => (
    <View style={styles.tabContent}>
      <RecentSalesSection
        expanded
        isLoading={model.isLoadingDashboard && !model.hasLoadedDashboard}
        onOpenSalesHistory={onOpenSalesHistory}
        onSalePress={model.openSaleEditor}
        onToggleExpanded={() => {}}
        sales={recentSalesTabItems}
        title="Latest Sales"
      />
    </View>
  );

  const renderFavoritesTab = () => (
    <View style={styles.tabContent}>
      <SectionHeader expanded title="Favorites" />

      {favoritesTabItems.length > 0 ? (
        <View style={styles.inventoryGrid}>
          {favoritesTabItems.map(renderInventoryTile)}
        </View>
      ) : (
        <StateCard
          message="Tap the star on a card's detail page to favorite it. Your favorites will appear here."
          style={styles.emptyStateCard}
          title="No favorites yet"
        />
      )}
    </View>
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <ScrollView
        testID="portfolio-scroll-view"
        contentContainerStyle={[
          styles.content,
          {
            paddingBottom: bottomNavClearance,
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.headerSpacer} />
          <Text
            numberOfLines={1}
            style={[theme.typography.headline, styles.headerTitle, { color: theme.colors.textPrimary }]}
            testID="portfolio-header-title"
          >
            Collection
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onOpenAccount}
            style={[styles.accountBadge, { backgroundColor: theme.colors.brand }]}
            testID="portfolio-account-button"
          >
            <Text style={[theme.typography.caption, { color: theme.colors.textInverse }]}>
              {accountInitials}
            </Text>
          </Pressable>
        </View>

        {shouldShowInitialError ? (
          <StateCard
            message={model.loadError || 'Please try again once your backend is reachable.'}
            title="Could not load your backend data"
            variant="field"
          />
        ) : (
          <>
            <View style={styles.summaryBlock}>
              <Text
                style={[theme.typography.display, styles.summaryValue, { color: theme.colors.textPrimary }]}
                testID="portfolio-summary-value"
              >
                {summaryValueLabel}
              </Text>
              <View style={styles.summaryDeltaRow}>
                <Text
                  style={[
                    theme.typography.caption,
                    {
                      color: summaryDeltaIsPositive ? theme.colors.success : theme.colors.danger,
                    },
                  ]}
                  testID="portfolio-summary-delta"
                >
                  {summaryDeltaLabel} {summaryDateLabel}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={() => setChartModeMenuOpen(true)}
                  style={[
                    styles.modeMenuButton,
                    {
                      backgroundColor: theme.colors.canvasElevated,
                      borderColor: theme.colors.outlineSubtle,
                    },
                  ]}
                  testID="portfolio-chart-mode-trigger"
                >
                  <MoreHoriz color={theme.colors.textSecondary} height={14} width={14} />
                </Pressable>
              </View>
            </View>

            <View style={[styles.chartWrap, { marginHorizontal: -theme.layout.pageGutter }]}>
              <PortfolioChartCard
                chartMode={model.chartMode}
                dashboard={model.dashboard}
                isLoading={model.isLoadingDashboard && !model.hasLoadedDashboard}
                onActivePointChange={setActiveChartPoint}
                onRangeChange={model.setSelectedRange}
                selectedRange={model.selectedRange}
              />
            </View>

            {model.loadError ? (
              <StateCard
                message={model.loadError}
                title="Could not refresh your backend data"
                variant="field"
              />
            ) : null}

            <PageTabs<CollectionTab>
              onChange={setActiveTab}
              tabs={collectionTabs}
              testID="portfolio-collection-tabs"
              value={activeTab}
            />

            {activeTab === 'portfolio'
              ? renderPortfolioTab()
              : activeTab === 'recent-sales'
                ? renderRecentSalesTab()
                : renderFavoritesTab()}
          </>
        )}
      </ScrollView>

      <Modal
        animationType="fade"
        onRequestClose={() => setChartModeMenuOpen(false)}
        transparent
        visible={chartModeMenuOpen}
      >
        <Pressable
          onPress={() => setChartModeMenuOpen(false)}
          style={styles.menuBackdrop}
          testID="portfolio-chart-mode-menu-backdrop"
        >
          <Pressable
            onPress={() => {}}
            style={[styles.menuSheet, { backgroundColor: theme.colors.canvasElevated }]}
          >
            {chartModeOptions.map((option) => {
              const selected = option.value === model.chartMode;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={option.value}
                  onPress={() => handleSelectChartMode(option.value)}
                  style={({ pressed }) => [
                    styles.menuOption,
                    pressed ? { backgroundColor: theme.colors.surfaceMuted } : null,
                  ]}
                  testID={`portfolio-chart-mode-option-${option.value}`}
                >
                  <Text style={[theme.typography.body, { color: theme.colors.textPrimary }]}>
                    {option.label}
                  </Text>
                  {selected ? (
                    <Text style={[theme.typography.caption, { color: theme.colors.brand }]}>
                      ✓
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        animationType="fade"
        onRequestClose={() => setTypeFilterMenuOpen(false)}
        transparent
        visible={typeFilterMenuOpen}
      >
        <Pressable
          onPress={() => setTypeFilterMenuOpen(false)}
          style={styles.menuBackdrop}
          testID="portfolio-inventory-filter-menu-backdrop"
        >
          <Pressable
            onPress={() => {}}
            style={[styles.menuSheet, { backgroundColor: theme.colors.canvasElevated }]}
          >
            {inventoryTypeFilterOptions.map((option) => {
              const selected = option.value === typeFilter;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={option.value}
                  onPress={() => handleSelectTypeFilter(option.value)}
                  style={({ pressed }) => [
                    styles.menuOption,
                    pressed ? { backgroundColor: theme.colors.surfaceMuted } : null,
                  ]}
                  testID={`portfolio-inventory-filter-option-${option.value}`}
                >
                  <Text style={[theme.typography.body, { color: theme.colors.textPrimary }]}>
                    {option.label}
                  </Text>
                  {selected ? (
                    <Text style={[theme.typography.caption, { color: theme.colors.brand }]}>
                      ✓
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>

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
  accountBadge: {
    alignItems: 'center',
    borderRadius: 20,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  chartWrap: {},
  content: {
    gap: 16,
  },
  emptyStateCard: {
    marginTop: 12,
  },
  filterIconPressable: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 40,
    justifyContent: 'space-between',
  },
  headerSpacer: {
    height: 36,
    width: 36,
  },
  headerTitle: {
    flex: 1,
    fontWeight: '600',
    textAlign: 'center',
  },
  inventoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 12,
  },
  inventoryTileWrap: {
    width: '48%',
  },
  menuBackdrop: {
    backgroundColor: 'rgba(0,0,0,0.32)',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  menuOption: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  menuSheet: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  modeMenuButton: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  safeArea: {
    flex: 1,
  },
  summaryBlock: {
    gap: 4,
  },
  summaryDeltaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  summaryValue: {
    fontWeight: '700',
  },
  tabContent: {
    gap: 12,
  },
});

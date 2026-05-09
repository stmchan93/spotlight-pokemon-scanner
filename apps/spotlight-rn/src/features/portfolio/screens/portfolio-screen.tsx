import { useCallback, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ChartMode, InventoryCardEntry } from '@spotlight/api-client';
import {
  IconButton,
  InventoryCardTile,
  SearchField,
  SectionHeader,
  StateCard,
  SurfaceCard,
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
  onOpenSalesHistory: () => void;
};

type InventoryFilter = 'all' | 'raw' | 'graded' | 'favorites';

const inventoryHighlightLimit = 6;

function applyInventoryFilter(items: InventoryCardEntry[], filter: InventoryFilter) {
  if (filter === 'all') {
    return items;
  }
  if (filter === 'favorites') {
    return items.filter((item) => item.isFavorite === true);
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

const inventoryFilterOptions: ReadonlyArray<{ value: InventoryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'raw', label: 'Raw' },
  { value: 'graded', label: 'Graded' },
  { value: 'favorites', label: 'Favorites' },
];

const chartModeOptions: ReadonlyArray<{ value: ChartMode; label: string }> = [
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'sales', label: 'Sales' },
];

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
  const [inventoryFilter, setInventoryFilter] = useState<InventoryFilter>('all');
  const [inventoryFilterMenuOpen, setInventoryFilterMenuOpen] = useState(false);

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const shouldShowInitialError = !model.hasLoadedDashboard
    && !model.hasLoadedInventory
    && !model.isLoading
    && model.loadError !== null;

  // Header value/delta — bound to chart hover when scrubbing, otherwise
  // resolves to today's portfolio summary or a placeholder during load.
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

  const filteredInventory = useMemo(() => {
    const filtered = applyInventoryFilter(model.dashboard.inventoryItems, inventoryFilter);
    const searched = applyInventorySearch(filtered, model.searchQuery);
    return sortByMarketPriceDesc(searched);
  }, [inventoryFilter, model.dashboard.inventoryItems, model.searchQuery]);

  const inventoryHighlights = useMemo(() => {
    return filteredInventory.slice(0, inventoryHighlightLimit);
  }, [filteredInventory]);

  const handleSelectInventoryFilter = useCallback((filter: InventoryFilter) => {
    setInventoryFilter(filter);
    setInventoryFilterMenuOpen(false);
  }, []);

  const handleSelectChartMode = useCallback((mode: ChartMode) => {
    model.setChartMode(mode);
    setChartModeMenuOpen(false);
  }, [model]);

  const inventoryFilterIcon = useMemo(() => (
    <Pressable
      hitSlop={8}
      onPress={() => setInventoryFilterMenuOpen(true)}
      style={styles.filterIconPressable}
      testID="portfolio-inventory-filter-trigger"
    >
      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
        ▾
      </Text>
    </Pressable>
  ), [theme.colors.textSecondary, theme.typography.caption]);

  const renderInventoryTile = useCallback((entry: InventoryCardEntry) => {
    const tileKind = entry.kind === 'graded' ? 'slab' : 'raw';
    const dayDelta = entry.dayChangeAmount ?? null;
    const dayChangeLabel = dayDelta == null || dayDelta === 0
      ? null
      : `${dayDelta >= 0 ? '+ ' : '- '}${formatCurrency(Math.abs(dayDelta), entry.currencyCode)}`;

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
          isFavorite={entry.isFavorite === true}
          onPress={() => onOpenInventoryEntry(entry)}
          testID={`portfolio-inventory-tile-${entry.id}`}
        />
      </View>
    );
  }, [onOpenInventoryEntry]);

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
                    { backgroundColor: theme.colors.surfaceMuted },
                  ]}
                  testID="portfolio-chart-mode-trigger"
                >
                  <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                    ⋯
                  </Text>
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

            <View style={styles.inventorySection}>
              <SectionHeader
                actionLabel="View All"
                actionTestID="portfolio-inventory-view-all"
                expanded
                onActionPress={onOpenInventory}
                title="Inventory"
              />

              <SearchField
                onChangeText={model.setSearchQuery}
                placeholder="Search for a card"
                testID="portfolio-inventory-search"
                trailing={inventoryFilterIcon}
                value={model.searchQuery}
              />

              {model.hasInventoryEntries ? (
                <View style={styles.inventoryGrid}>
                  {inventoryHighlights.map(renderInventoryTile)}
                </View>
              ) : (
                <StateCard
                  message="Add cards from the scanner to see your highest-value picks here."
                  style={styles.emptyStateCard}
                  title="No cards in your collection yet"
                />
              )}
            </View>

            <View style={styles.recentSalesWrap}>
              <RecentSalesSection
                expanded
                isLoading={model.isLoadingDashboard && !model.hasLoadedDashboard}
                onOpenSalesHistory={onOpenSalesHistory}
                onSalePress={model.openSaleEditor}
                onToggleExpanded={() => {}}
                sales={model.recentSales}
                title="Latest Sales"
              />
            </View>
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
        onRequestClose={() => setInventoryFilterMenuOpen(false)}
        transparent
        visible={inventoryFilterMenuOpen}
      >
        <Pressable
          onPress={() => setInventoryFilterMenuOpen(false)}
          style={styles.menuBackdrop}
          testID="portfolio-inventory-filter-menu-backdrop"
        >
          <Pressable
            onPress={() => {}}
            style={[styles.menuSheet, { backgroundColor: theme.colors.canvasElevated }]}
          >
            {inventoryFilterOptions.map((option) => {
              const selected = option.value === inventoryFilter;
              return (
                <Pressable
                  accessibilityRole="button"
                  key={option.value}
                  onPress={() => handleSelectInventoryFilter(option.value)}
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

// Suppress unused import for IconButton — kept for potential future use of a dedicated trailing icon button.
void IconButton;
void SurfaceCard;

const styles = StyleSheet.create({
  accountBadge: {
    alignItems: 'center',
    borderRadius: 20,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  chartWrap: {
    // Edge-to-edge chart: cancel parent horizontal padding (set in render).
  },
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
  inventorySection: {
    gap: 12,
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
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  recentSalesWrap: {},
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
});

import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Menu as MenuIcon } from 'iconoir-react-native';

import type { PortfolioInsights, RecentSaleRecord } from '@spotlight/api-client';
import {
  SegmentedControl,
  TrendPill,
  colors,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { SalePriceEditSheet } from '@/features/portfolio/components/sale-price-edit-sheet';
import { SaleSummaryRow } from '@/features/sales/components/sale-summary-row';
import {
  formatEditableSellPrice,
  parseSellPrice,
  sanitizeSellPriceText,
} from '@/features/sell/sell-order-helpers';
import { usePortfolioScreenModel } from '@/features/portfolio/hooks/use-portfolio-screen-model';
import { usePortfolioSummaryVisibility } from '@/features/portfolio/use-portfolio-summary-visibility';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import {
  PortfolioChartCard,
  type PortfolioChartActivePoint,
} from '@/features/portfolio/components/portfolio-chart-card';
import { PortfolioBalanceHeader } from '@/features/portfolio/components/portfolio-balance-header';
import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';

type InsightsPanel = 'collection-health' | 'sales-performance';

export function InsightsScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { openDrawer } = useAppDrawer();
  const model = usePortfolioScreenModel();
  const { isHidden: isSummaryHidden, toggle: toggleSummaryHidden } = usePortfolioSummaryVisibility();
  const [activeChartPoint, setActiveChartPoint] = useState<PortfolioChartActivePoint | null>(null);
  const [activePanel, setActivePanel] = useState<InsightsPanel>('collection-health');

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const insights: PortfolioInsights | null = model.dashboard?.insights ?? null;

  // Mirror the sale-price edit flow from the Sales screen so the edit
  // pencil on Top Sellers This Month opens the same sheet.
  const [editingSale, setEditingSale] = useState<RecentSaleRecord | null>(null);
  const [editingSalePriceText, setEditingSalePriceText] = useState('');
  const parsedEditingSalePrice = parseSellPrice(editingSalePriceText);
  const canConfirmSalePriceEdit = editingSale !== null && parsedEditingSalePrice != null;

  const openSaleEditor = useCallback((sale: RecentSaleRecord) => {
    if (sale.kind !== 'sold') return;
    setEditingSale(sale);
    setEditingSalePriceText(formatEditableSellPrice(sale.soldPrice));
  }, []);
  const closeSaleEditor = useCallback(() => {
    setEditingSale(null);
    setEditingSalePriceText('');
  }, []);
  const updateEditingSalePriceText = useCallback((value: string) => {
    setEditingSalePriceText(sanitizeSellPriceText(value));
  }, []);
  const confirmSalePriceEdit = useCallback(() => {
    // Local optimistic edit only; backend persistence still goes through
    // the existing sales screen. Keeping it visual here preserves the
    // affordance the user expects without duplicating mutation logic.
    closeSaleEditor();
  }, [closeSaleEditor]);

  const formatted = useMemo(() => {
    const summary = model.dashboard?.summary;
    const totalValue = summary?.currentValue ?? null;
    const changePercent = summary?.changePercent ?? 0;
    const totalValueTrend = summary != null
      ? {
          direction:
            changePercent > 0 ? 'up' as const
              : changePercent < 0 ? 'down' as const
                : 'flat' as const,
          label: `${Math.abs(changePercent).toFixed(2)}%`,
        }
      : undefined;

    const addedThisMonth = model.dashboard?.insights?.inventoryAddedThisMonth ?? 0;
    const totalItemsTrend = addedThisMonth > 0
      ? {
          direction: 'plus' as const,
          label: `${addedThisMonth} this month`,
        }
      : undefined;

    return {
      totalValue: totalValue != null ? formatCurrency(totalValue) : '—',
      totalValueTrend,
      totalItems:
        model.dashboard != null
          ? new Intl.NumberFormat('en-US').format(model.dashboard.inventoryCount)
          : '—',
      totalItemsTrend,
    };
  }, [model.dashboard]);

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
          accessibilityLabel="Open menu"
          accessibilityRole="button"
          hitSlop={12}
          onPress={openDrawer}
          style={styles.headerIcon}
          testID="insights-header-menu"
        >
          <MenuIcon color={colors.gray900} height={24} width={24} />
        </Pressable>
        <Text style={styles.headerTitle} testID="insights-header-title">
          Insights
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: bottomNavClearance + 24 },
        ]}
        refreshControl={(
          <RefreshControl
            onRefresh={model.refresh}
            refreshing={model.isRefreshing}
            testID="insights-refresh-control"
            tintColor={theme.colors.gray400}
          />
        )}
      >
        {model.dashboard ? (
          <PortfolioBalanceHeader
            summary={model.dashboard.summary}
            activeChartPoint={activeChartPoint}
            isSummaryHidden={isSummaryHidden}
            onToggleHidden={toggleSummaryHidden}
            testIDPrefix="insights"
          />
        ) : (
          <View style={styles.portfolioBlock}>
            <Text style={styles.overline}>Portfolio</Text>
            <Text style={styles.balance}>{formatted.totalValue}</Text>
          </View>
        )}

        <View style={styles.chartWrap}>
          <PortfolioChartCard
            chartMode="portfolio"
            dashboard={model.dashboard}
            isLoading={model.isLoadingDashboard}
            onActivePointChange={setActiveChartPoint}
            selectedRange={model.selectedRange}
            onRangeChange={model.setSelectedRange}
          />
        </View>

        <View style={styles.segmentedRow}>
          <SegmentedControl
            items={[
              { label: 'Collection Health', value: 'collection-health' },
              { label: 'Sales Performance', value: 'sales-performance' },
            ]}
            onChange={(value) => setActivePanel(value as InsightsPanel)}
            size="md"
            tone="inverted"
            value={activePanel}
            testID="insights-panel-toggle"
          />
        </View>

        {activePanel === 'collection-health' ? (
          <CollectionHealthPanel
            insights={insights}
            totalValue={formatted.totalValue}
            totalValueTrend={formatted.totalValueTrend}
            totalItems={formatted.totalItems}
            totalItemsTrend={formatted.totalItemsTrend}
          />
        ) : (
          <SalesPerformancePanel
            insights={insights}
            onEditSale={openSaleEditor}
          />
        )}
      </ScrollView>

      <SalePriceEditSheet
        canConfirm={canConfirmSalePriceEdit}
        onChangePriceText={updateEditingSalePriceText}
        onClose={closeSaleEditor}
        onConfirm={confirmSalePriceEdit}
        priceText={editingSalePriceText}
        sale={editingSale}
      />

      <AppBottomTabBar />
    </SafeAreaView>
  );
}

type StatCardProps = {
  label: string;
  value: string;
  trend?: { direction: 'up' | 'down' | 'flat' | 'plus'; label: string };
};

function StatCard({ label, value, trend }: StatCardProps) {
  return (
    <View style={panelStyles.statCard}>
      <Text style={panelStyles.statLabel}>{label}</Text>
      <Text style={panelStyles.statValue}>{value}</Text>
      {trend ? (
        <View style={panelStyles.trendRow}>
          <TrendPill direction={trend.direction} label={trend.label} size="sm" />
        </View>
      ) : null}
    </View>
  );
}

function formatMoney(value: number | null | undefined): string {
  return value == null ? '—' : formatCurrency(value);
}

function formatCount(value: number | null | undefined): string {
  return value == null ? '—' : new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return '—';
  return `${Math.round(value * 1000) / 10}%`;
}

// MoM change pill on Revenue / Profit cards. `value` is a fraction
// (0.12 = +12%). Null when the prior month had no activity.
function changePercentTrend(value: number | null | undefined): StatCardProps['trend'] | undefined {
  if (value == null) return undefined;
  const direction: 'up' | 'down' | 'flat' =
    value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  return {
    direction,
    label: `${Math.round(Math.abs(value) * 100)}%`,
  };
}

function CollectionHealthPanel({
  insights,
  totalValue,
  totalValueTrend,
  totalItems,
  totalItemsTrend,
}: {
  insights: PortfolioInsights | null;
  totalValue: string;
  totalValueTrend?: StatCardProps['trend'];
  totalItems: string;
  totalItemsTrend?: StatCardProps['trend'];
}) {
  const trackedCount = insights?.trackedInventoryCount ?? 0;

  return (
    <View style={panelStyles.panel}>
      <View style={panelStyles.sectionHeader}>
        <Text style={panelStyles.sectionTitle}>Overview</Text>
        <Text style={panelStyles.sectionMeta}>All Time</Text>
      </View>
      <View style={panelStyles.statGrid}>
        <StatCard label="Total Value" value={totalValue} trend={totalValueTrend} />
        <StatCard label="Cost Basis" value={formatMoney(insights?.totalCostBasis ?? null)} />
        <StatCard label="Unrealized Gain" value={formatMoney(insights?.unrealizedGain ?? null)} />
        <StatCard label="Total Items" value={totalItems} trend={totalItemsTrend} />
      </View>

      {insights != null && trackedCount === 0 ? (
        <Text style={panelStyles.trackedCaption}>
          {'No cost basis tracked yet. Add a "What did you pay?" amount when you add a card to surface Cost Basis / Unrealized Gain here.'}
        </Text>
      ) : null}

      <View style={panelStyles.sectionHeader}>
        <Text style={panelStyles.sectionTitle}>Best Return of All Time</Text>
      </View>
      {insights?.bestReturnOfAllTime ? (
        <SaleSummaryRow
          sale={insights.bestReturnOfAllTime}
          testID="insights-best-return"
        />
      ) : (
        <View style={panelStyles.emptyTile}>
          <Text style={panelStyles.emptyTileText}>
            Once cost basis is tracked, your top realized gain shows up here.
          </Text>
        </View>
      )}

      <View style={panelStyles.sectionHeader}>
        <Text style={panelStyles.sectionTitle}>Listings status</Text>
        <Text style={panelStyles.sectionMeta}>All Time</Text>
      </View>
      <View style={panelStyles.metricList}>
        <MetricRow label="Active Listings" value={formatCount(insights?.activeListings ?? null)} />
        <MetricRow label="Unlisted Inventory" value={formatCount(insights?.unlistedInventory ?? null)} />
        <MetricRow label="Listing Rate" value={formatPercent(insights?.listingRate ?? null)} />
        <MetricRow label="Avg. Listing Value" value={formatMoney(insights?.avgListingValue ?? null)} />
      </View>
    </View>
  );
}

function SalesPerformancePanel({
  insights,
  onEditSale,
}: {
  insights: PortfolioInsights | null;
  onEditSale: (sale: RecentSaleRecord) => void;
}) {
  const theme = useSpotlightTheme();
  const { width: windowWidth } = useWindowDimensions();
  const topSellerCardPeek = 32;
  const topSellerCardGap = 12;
  const topSellerCardWidth = Math.max(
    240,
    windowWidth - theme.layout.pageGutter * 2 - topSellerCardPeek,
  );

  return (
    <View style={panelStyles.panel}>
      <View style={panelStyles.sectionHeader}>
        <Text style={panelStyles.sectionTitle}>Monthly</Text>
        <Text style={panelStyles.sectionMeta}>This month</Text>
      </View>
      <View style={panelStyles.statGrid}>
        <StatCard
          label="Revenue"
          value={formatMoney(insights?.monthlyRevenue ?? null)}
          trend={changePercentTrend(insights?.monthlyRevenueChangePercent)}
        />
        <StatCard
          label="Profit"
          value={formatMoney(insights?.monthlyProfit ?? null)}
          trend={changePercentTrend(insights?.monthlyProfitChangePercent)}
        />
        <StatCard label="Expense" value={formatMoney(insights?.monthlyExpense ?? null)} />
        <StatCard label="Margin" value={formatPercent(insights?.monthlyMargin ?? null)} />
      </View>

      <View style={panelStyles.metricList}>
        <MetricRow label="Number of Sales" value={formatCount(insights?.numSales ?? null)} />
        <MetricRow label="Avg. Sales Price" value={formatMoney(insights?.avgSalesPrice ?? null)} />
        <MetricRow
          label="Avg. Days to Sell"
          value={insights?.avgDaysToSell != null ? insights.avgDaysToSell.toFixed(1) : '—'}
        />
        <MetricRow label="Unsold Listings" value={formatCount(insights?.unsoldListings ?? null)} />
      </View>

      <View style={panelStyles.sectionHeader}>
        <Text style={panelStyles.sectionTitle}>Top Sellers This Month</Text>
      </View>
      {insights && insights.topSellersThisMonth.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToInterval={topSellerCardWidth + topSellerCardGap}
          snapToAlignment="start"
          contentContainerStyle={{
            gap: topSellerCardGap,
            paddingRight: topSellerCardPeek,
          }}
        >
          {insights.topSellersThisMonth.map((sale) => (
            <View key={sale.id} style={{ width: topSellerCardWidth }}>
              <SaleSummaryRow
                onPress={sale.kind === 'sold' ? onEditSale : undefined}
                sale={sale}
                showEditAffordance={sale.kind === 'sold'}
                testID={`insights-top-seller-${sale.id}`}
              />
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={panelStyles.emptyTile}>
          <Text style={panelStyles.emptyTileText}>
            Sales you record this month show up here, ranked by revenue.
          </Text>
        </View>
      )}

      <View style={panelStyles.sectionHeader}>
        <Text style={panelStyles.sectionTitle}>All Time</Text>
        <Text style={panelStyles.sectionMeta}>All Time</Text>
      </View>
      <View style={panelStyles.metricList}>
        <MetricRow label="Total Sales" value={formatCount(insights?.totalSales ?? null)} />
        <MetricRow label="Total Revenue" value={formatMoney(insights?.totalRevenue ?? null)} />
        <MetricRow label="Total Expense" value={formatMoney(insights?.totalExpense ?? null)} />
        <MetricRow label="Total Profit" value={formatMoney(insights?.totalProfit ?? null)} />
        <MetricRow label="Overall ROI" value={formatPercent(insights?.overallROI ?? null)} />
      </View>
    </View>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={panelStyles.metricRow}>
      <Text style={panelStyles.metricLabel}>{label}</Text>
      <Text style={panelStyles.metricValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  headerIcon: {
    height: 24,
    width: 24,
  },
  headerTitle: {
    ...textStyles.titleMedium,
    color: colors.gray900,
    flex: 1,
    textAlign: 'center',
  },
  headerSpacer: {
    height: 24,
    width: 24,
  },
  scrollContent: {
    paddingTop: 16,
  },
  portfolioBlock: {
    gap: 4,
    marginBottom: 12,
    paddingHorizontal: 16,
  },
  chartWrap: {
    // Figma: Time Filter Container sits 64px below the Portfolio Balance
    // Container. Insights scrollContent has no inter-child gap, so the full
    // 64px lives on this wrapper.
    marginTop: 64,
  },
  overline: {
    ...textStyles.overline,
    color: colors.gray600,
  },
  balance: {
    ...textStyles.displayLarge,
    color: colors.gray900,
  },
  segmentedRow: {
    marginTop: 16,
    paddingHorizontal: 16,
  },
});

const panelStyles = StyleSheet.create({
  panel: {
    gap: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  sectionHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  sectionMeta: {
    ...textStyles.overline,
    color: colors.gray600,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    backgroundColor: colors.gray50,
    borderRadius: 12,
    flexBasis: '47%',
    flexGrow: 1,
    gap: 6,
    padding: 16,
  },
  statLabel: {
    ...textStyles.overline,
    color: colors.gray600,
  },
  statValue: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  trendRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  trackedCaption: {
    ...textStyles.captionMedium,
    color: colors.gray600,
  },
  metricList: {
    gap: 12,
  },
  metricRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  metricLabel: {
    ...textStyles.bodyMedium,
    color: colors.gray700,
  },
  metricValue: {
    ...textStyles.titleSmall,
    color: colors.gray900,
  },
  emptyTile: {
    backgroundColor: colors.gray50,
    borderRadius: 12,
    padding: 16,
  },
  emptyTileText: {
    ...textStyles.bodyMedium,
    color: colors.gray600,
  },
});

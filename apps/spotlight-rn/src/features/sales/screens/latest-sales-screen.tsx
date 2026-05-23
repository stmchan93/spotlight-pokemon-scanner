import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Menu as MenuIcon } from 'iconoir-react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RecentSaleRecord } from '@spotlight/api-client';
import {
  SearchField,
  StateCard,
  colors,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { SalePriceEditSheet } from '@/features/portfolio/components/sale-price-edit-sheet';
import { SaleSummaryRow } from '@/features/sales/components/sale-summary-row';
import { SalesStatTileRow } from '@/features/sales/components/sales-stat-tile-row';
import {
  SalesFilterChipRow,
  type SalesFilterKey,
} from '@/features/sales/components/sales-filter-chip-row';
import {
  formatEditableSellPrice,
  parseSellPrice,
  sanitizeSellPriceText,
} from '@/features/sell/sell-order-helpers';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAppServices } from '@/providers/app-providers';
import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';

function LatestSalesSkeleton() {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.skeletonList} testID="latest-sales-screen-skeleton">
      {Array.from({ length: 4 }).map((_, index) => (
        <View key={index} style={styles.skeletonCard}>
          <View style={styles.skeletonLeftGroup}>
            <View
              style={[
                styles.skeletonArt,
                { backgroundColor: theme.colors.outlineSubtle },
              ]}
            />
            <View style={styles.skeletonTextColumn}>
              <View style={[styles.skeletonLineWide, { backgroundColor: theme.colors.outlineSubtle }]} />
              <View style={[styles.skeletonLineMedium, { backgroundColor: theme.colors.outlineSubtle }]} />
              <View style={[styles.skeletonLineNarrow, { backgroundColor: theme.colors.outlineSubtle }]} />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

export function LatestSalesScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { spotlightRepository, dataVersion } = useAppServices();
  const { openDrawer } = useAppDrawer();

  const [sales, setSales] = useState<RecentSaleRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingSaleId, setEditingSaleId] = useState<string | null>(null);
  const [editingSalePriceText, setEditingSalePriceText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<SalesFilterKey>('all');

  const editingSale = sales.find((sale) => sale.id === editingSaleId && sale.kind === 'sold') ?? null;
  const parsedEditingSalePrice = parseSellPrice(editingSalePriceText);
  const canConfirmSalePriceEdit = editingSale !== null && parsedEditingSalePrice != null;

  const openSaleEditor = useCallback((sale: RecentSaleRecord) => {
    if (sale.kind !== 'sold') return;
    setEditingSaleId(sale.id);
    setEditingSalePriceText(formatEditableSellPrice(sale.soldPrice));
  }, []);

  const closeSaleEditor = useCallback(() => {
    setEditingSaleId(null);
    setEditingSalePriceText('');
  }, []);

  const updateEditingSalePriceText = useCallback((value: string) => {
    setEditingSalePriceText(sanitizeSellPriceText(value));
  }, []);

  const confirmSalePriceEdit = useCallback(() => {
    if (!editingSaleId || parsedEditingSalePrice == null) return;
    setSales((prev) => prev.map((sale) => (
      sale.id === editingSaleId ? { ...sale, soldPrice: parsedEditingSalePrice } : sale
    )));
    closeSaleEditor();
  }, [closeSaleEditor, editingSaleId, parsedEditingSalePrice]);

  const loadSales = useCallback(async () => {
    const loadResult = await spotlightRepository.loadPortfolioDashboard();
    if (loadResult.data && loadResult.state !== 'error') {
      setSales(loadResult.data.recentSales);
      setLoadError(null);
    } else {
      setLoadError(loadResult.state === 'error' ? loadResult.errorMessage : null);
    }
    setHasLoaded(true);
  }, [spotlightRepository]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      await loadSales();
      if (!cancelled) {
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataVersion, loadSales]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await loadSales();
    } finally {
      setIsRefreshing(false);
    }
  }, [loadSales]);

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const showInitialSkeleton = isLoading && !hasLoaded;
  const showInitialError = !isLoading && !isRefreshing && loadError !== null && sales.length === 0;
  const showEmptyState = !isLoading && !isRefreshing && loadError === null && sales.length === 0;

  const aggregates = useMemo(() => {
    const totalSales = sales.length;
    const totalValue = sales.reduce(
      (sum, sale) => sum + sale.soldPrice * (sale.quantity ?? 1),
      0,
    );
    const profits = sales
      .map((sale) => sale.profit)
      .filter((value): value is number => value != null);
    const totalProfit = profits.reduce((sum, value) => sum + value, 0);
    const hasProfit = profits.length > 0;
    return {
      totalSalesLabel: new Intl.NumberFormat('en-US').format(totalSales),
      totalValueLabel: formatCurrency(totalValue),
      totalProfitLabel: hasProfit ? formatCurrency(totalProfit) : '—',
    };
  }, [sales]);

  const visibleSales = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const searched = normalizedQuery
      ? sales.filter((sale) => {
          const haystack = [sale.name, sale.setName, sale.cardNumber]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(normalizedQuery);
        })
      : sales;

    switch (activeFilter) {
      case 'az':
        return [...searched].sort((a, b) => a.name.localeCompare(b.name));
      case 'date':
        return [...searched].sort((a, b) => b.soldAtISO.localeCompare(a.soldAtISO));
      case 'ungraded':
        return searched.filter((sale) => {
          const label = sale.qualityLabel?.toLowerCase() ?? '';
          // raw conditions don't include grader prefixes like "PSA"/"BGS"/"SGC"
          return !/(psa|bgs|sgc|cgc)\b/.test(label);
        });
      case 'graded':
        return searched.filter((sale) => {
          const label = sale.qualityLabel?.toLowerCase() ?? '';
          return /(psa|bgs|sgc|cgc)\b/.test(label);
        });
      case 'pokemon':
        // No TCG field on RecentSaleRecord today — chip is aspirational
        // until multi-TCG lands. Pass-through.
        return searched;
      case 'all':
      default:
        return searched;
    }
  }, [activeFilter, sales, searchQuery]);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
    >
      <View style={[styles.screen, { paddingBottom: bottomNavClearance }]}>
        <View style={salesStyles.headerRow}>
          <Pressable
            accessibilityLabel="Open menu"
            accessibilityRole="button"
            hitSlop={12}
            onPress={openDrawer}
            style={salesStyles.headerIcon}
            testID="sales-header-menu"
          >
            <MenuIcon color={theme.colors.gray900} height={24} width={24} />
          </Pressable>
          <Text style={salesStyles.headerTitle} testID="sales-header-title">
            Sales
          </Text>
          <View style={salesStyles.headerSpacer} />
        </View>

        {showInitialSkeleton ? (
          <LatestSalesSkeleton />
        ) : showInitialError ? (
          <StateCard
            message={loadError ?? 'Please try again once your backend is reachable.'}
            style={styles.stateCard}
            title="Could not load sales"
            variant="field"
          />
        ) : showEmptyState ? (
          <StateCard
            message="Completed sales will appear here as soon as you start moving inventory."
            style={styles.stateCard}
            title="No sales yet"
          />
        ) : (
          <ScrollView
            contentContainerStyle={salesStyles.scrollContent}
            refreshControl={(
              <RefreshControl
                onRefresh={handleRefresh}
                refreshing={isRefreshing}
                testID="latest-sales-refresh"
                tintColor={theme.colors.gray400}
              />
            )}
            testID="latest-sales-scroll"
          >
            <SalesStatTileRow
              totalSales={aggregates.totalSalesLabel}
              totalValue={aggregates.totalValueLabel}
              totalProfit={aggregates.totalProfitLabel}
            />

            <Text style={salesStyles.sectionTitle} testID="sales-transactions-title">
              Transactions
            </Text>

            <View style={salesStyles.searchRow}>
              <SearchField
                accessibilityLabel="Search your sales"
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="while-editing"
                onChangeText={setSearchQuery}
                placeholder="Search your sales"
                returnKeyType="search"
                size="collection"
                surface="muted"
                value={searchQuery}
              />
            </View>

            <SalesFilterChipRow
              activeFilter={activeFilter}
              onFilterChange={setActiveFilter}
            />

            {visibleSales.length === 0 ? (
              <View style={salesStyles.emptyWrap}>
                <StateCard
                  message="Try a different search or chip to find this sale."
                  title="No sales match"
                />
              </View>
            ) : (
              <View style={salesStyles.salesList} testID="latest-sales-list">
                {visibleSales.map((sale) => (
                  <SaleSummaryRow
                    key={sale.id}
                    onPress={sale.kind === 'sold' ? openSaleEditor : undefined}
                    sale={sale}
                    showEditAffordance={sale.kind === 'sold'}
                    testID={`latest-sale-card-${sale.id}`}
                  />
                ))}
              </View>
            )}
          </ScrollView>
        )}
      </View>

      <SalePriceEditSheet
        canConfirm={canConfirmSalePriceEdit}
        onChangePriceText={updateEditingSalePriceText}
        onClose={closeSaleEditor}
        onConfirm={confirmSalePriceEdit}
        priceText={editingSalePriceText}
        sale={editingSale}
      />

      <CollectionAddFab />

      <AppBottomTabBar />
    </SafeAreaView>
  );
}

const salesStyles = StyleSheet.create({
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
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
    gap: 16,
    paddingBottom: 24,
    paddingTop: 8,
  },
  sectionTitle: {
    ...textStyles.titleMedium,
    color: colors.gray900,
    paddingHorizontal: 16,
  },
  searchRow: {
    paddingHorizontal: 16,
  },
  salesList: {
    gap: 8,
    paddingHorizontal: 16,
  },
  emptyWrap: {
    paddingHorizontal: 16,
  },
});

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  screen: {
    flex: 1,
    gap: 18,
    paddingTop: 8,
  },
  skeletonList: {
    gap: 12,
    paddingHorizontal: 16,
  },
  skeletonCard: {
    alignItems: 'flex-start',
    backgroundColor: colors.gray50,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
  },
  skeletonLeftGroup: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 16,
    minWidth: 0,
  },
  skeletonTextColumn: {
    flex: 1,
    gap: 8,
    minWidth: 0,
  },
  skeletonArt: {
    aspectRatio: 88 / 128,
    borderRadius: 6,
    height: 94,
  },
  skeletonLineMedium: {
    borderRadius: 999,
    height: 12,
    width: '58%',
  },
  skeletonLineNarrow: {
    borderRadius: 999,
    height: 10,
    width: '42%',
  },
  skeletonLineWide: {
    borderRadius: 999,
    height: 16,
    width: '76%',
  },
  stateCard: {
    alignItems: 'flex-start',
    marginHorizontal: 16,
    paddingVertical: 20,
  },
});

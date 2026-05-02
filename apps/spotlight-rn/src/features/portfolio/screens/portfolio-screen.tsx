import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { StateCard, useSpotlightTheme } from '@spotlight/design-system';

import { InventoryGrid } from '@/features/portfolio/components/inventory-grid';
import { PortfolioChartCard } from '@/features/portfolio/components/portfolio-chart-card';
import { RecentSalesSection } from '@/features/portfolio/components/recent-sales-section';
import { SalePriceEditSheet } from '@/features/portfolio/components/sale-price-edit-sheet';
import { usePortfolioScreenModel } from '@/features/portfolio/hooks/use-portfolio-screen-model';

type PortfolioScreenProps = {
  accountInitials?: string;
  onOpenAddCard?: () => void;
  onOpenAccount?: () => void;
  onOpenInventory?: () => void;
  onOpenInventoryEntry?: (entry: InventoryCardEntry) => void;
  onOpenSalesHistory: () => void;
  onOpenSellSelection?: (entryId?: string) => void;
};

export function PortfolioScreen({
  accountInitials = 'AC',
  onOpenAddCard = () => {},
  onOpenAccount = () => {},
  onOpenInventory = () => {},
  onOpenInventoryEntry = () => {},
  onOpenSalesHistory,
  onOpenSellSelection = () => {},
}: PortfolioScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const model = usePortfolioScreenModel();
  const shouldShowInitialError = !model.hasLoadedDashboard
    && !model.hasLoadedInventory
    && !model.isLoading
    && model.loadError !== null;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[
        styles.safeArea,
        {
          backgroundColor: theme.colors.canvas,
        },
      ]}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            gap: theme.layout.sectionGap,
            paddingBottom: theme.layout.bottomNavHeight + insets.bottom + 48,
            paddingHorizontal: theme.layout.pageGutter,
            paddingTop: theme.layout.pageTopInset,
          },
        ]}
      >
        <View style={styles.header}>
          <View style={[styles.headerCopy, { gap: theme.layout.titleBodyGap }]}>
            <Text style={theme.typography.display}>Collection</Text>
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              Track value, favorites, and your latest transactions in one place.
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={onOpenAccount}
            style={[
              styles.accountBadge,
              {
                backgroundColor: theme.colors.brand,
              },
            ]}
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
            <PortfolioChartCard
              chartMode={model.chartMode}
              dashboard={model.dashboard}
              isLoading={model.isLoadingDashboard && !model.hasLoadedDashboard}
              onModeChange={model.setChartMode}
              onRangeChange={model.setSelectedRange}
              selectedRange={model.selectedRange}
            />

            {model.loadError ? (
              <StateCard
                message={model.loadError}
                title="Could not refresh your backend data"
                variant="field"
              />
            ) : null}

            <InventoryGrid
              hasInventoryEntries={model.hasInventoryEntries}
              isLoading={model.isLoadingInventory && !model.hasInventoryEntries}
              inventoryCount={model.inventoryTotalCount}
              inventoryExpanded={model.inventoryExpanded}
              inventoryItems={model.filteredInventory}
              onOpenAddCard={onOpenAddCard}
              onOpenEntry={onOpenInventoryEntry}
              onOpenInventory={onOpenInventory}
              onOpenSellSelection={onOpenSellSelection}
              onSearchChange={model.setSearchQuery}
              onToggleExpanded={() => model.setInventoryExpanded((value) => !value)}
              searchQuery={model.searchQuery}
            />

            <View style={[styles.recentSalesWrap, { marginTop: theme.layout.sectionGapLarge - theme.layout.sectionGap }]}>
              <RecentSalesSection
                expanded={model.recentSalesExpanded}
                isLoading={model.isLoadingDashboard && !model.hasLoadedDashboard}
                onOpenSalesHistory={onOpenSalesHistory}
                onSalePress={model.openSaleEditor}
                onToggleExpanded={() => model.setRecentSalesExpanded((value) => !value)}
                sales={model.recentSales}
                title="Latest Sales"
              />
            </View>
          </>
        )}
      </ScrollView>

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
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  content: {
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerCopy: {
    flex: 1,
    paddingRight: 16,
  },
  recentSalesWrap: {
  },
  safeArea: {
    flex: 1,
  },
});

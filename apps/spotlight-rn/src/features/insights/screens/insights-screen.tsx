import { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Menu as MenuIcon } from 'iconoir-react-native';

import type { TransactionInsights, TransactionKindStat } from '@spotlight/api-client';
import { colors, textStyles, useSpotlightTheme } from '@spotlight/design-system';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { TransactionRow } from '@/features/sales/components/transaction-row';
import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAppServices } from '@/providers/app-providers';
import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';

export function InsightsScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { openDrawer } = useAppDrawer();
  const handleTabBarScroll = useTabBarScrollHandler();
  const { spotlightRepository, dataVersion } = useAppServices();
  const { width: windowWidth } = useWindowDimensions();

  const [insights, setInsights] = useState<TransactionInsights | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await spotlightRepository.loadTransactionInsights();
      setInsights(result);
    } catch {
      // Keep the last value; the refresh control + next focus will retry.
    }
  }, [spotlightRepository]);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await load();
    setIsRefreshing(false);
  }, [load]);

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  // One-and-a-peek carousel width for Top Sales (matches the old top-sellers feel).
  const topSaleCardPeek = 32;
  const topSaleCardGap = 12;
  const topSaleCardWidth = Math.max(
    260,
    windowWidth - theme.layout.pageGutter * 2 - topSaleCardPeek,
  );

  const topSales = insights?.topSalesThisMonth ?? [];

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
        onScroll={handleTabBarScroll}
        scrollEventThrottle={16}
        refreshControl={(
          <RefreshControl
            onRefresh={handleRefresh}
            refreshing={isRefreshing}
            testID="insights-refresh-control"
            tintColor={theme.colors.gray400}
          />
        )}
        testID="insights-scroll"
      >
        <Section title="This month">
          <View style={styles.statGrid}>
            <KindStatCard label="Sold" stat={insights?.thisMonth.sold} testID="insights-month-sold" />
            <KindStatCard label="Bought" stat={insights?.thisMonth.bought} testID="insights-month-bought" />
            <KindStatCard label="Traded" stat={insights?.thisMonth.traded} showAmount={false} testID="insights-month-traded" />
          </View>
        </Section>

        <Section title="Top sales this month">
          {topSales.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              decelerationRate="fast"
              snapToInterval={topSaleCardWidth + topSaleCardGap}
              snapToAlignment="start"
              contentContainerStyle={{ gap: topSaleCardGap, paddingRight: topSaleCardPeek }}
              testID="insights-top-sales"
            >
              {topSales.map((sale) => (
                <View key={sale.id} style={{ width: topSaleCardWidth }}>
                  <TransactionRow
                    firstInList
                    record={sale}
                    testID={`insights-top-sale-${sale.id}`}
                  />
                </View>
              ))}
            </ScrollView>
          ) : (
            <EmptyTile text="Sales you log this month show up here, ranked by price." />
          )}
        </Section>

        <Section title="Biggest sale">
          {insights?.biggestSale ? (
            <TransactionRow
              firstInList
              record={insights.biggestSale}
              testID="insights-biggest-sale"
            />
          ) : (
            <EmptyTile text="Your highest-price sale will show up here." />
          )}
        </Section>

        <Section title="All time">
          <View style={styles.statGrid}>
            <KindStatCard label="Sold" stat={insights?.allTime.sold} testID="insights-all-sold" />
            <KindStatCard label="Bought" stat={insights?.allTime.bought} testID="insights-all-bought" />
            <KindStatCard label="Traded" stat={insights?.allTime.traded} showAmount={false} testID="insights-all-traded" />
          </View>
        </Section>
      </ScrollView>

      <AppBottomTabBar />
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function KindStatCard({
  label,
  stat,
  showAmount = true,
  testID,
}: {
  label: string;
  stat?: TransactionKindStat;
  showAmount?: boolean;
  testID?: string;
}) {
  const count = stat?.count ?? 0;
  const amount = (stat?.amountCents ?? 0) / 100;
  return (
    <View style={styles.statCard} testID={testID}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{formatCount(count)}</Text>
      <Text style={styles.statCaption}>{showAmount ? formatCurrency(amount) : 'cards'}</Text>
    </View>
  );
}

function EmptyTile({ text }: { text: string }) {
  return (
    <View style={styles.emptyTile}>
      <Text style={styles.emptyTileText}>{text}</Text>
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
    gap: 24,
    paddingTop: 16,
  },
  section: {
    gap: 12,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  statGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  statCard: {
    backgroundColor: colors.gray50,
    borderRadius: 12,
    flex: 1,
    gap: 4,
    minHeight: 96,
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
  statCaption: {
    ...textStyles.captionMedium,
    color: colors.gray600,
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

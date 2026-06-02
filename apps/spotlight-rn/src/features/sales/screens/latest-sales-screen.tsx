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

import type { CardTransactionKind, CardTransactionRecord } from '@spotlight/api-client';
import {
  SearchField,
  SegmentedControl,
  StateCard,
  colors,
  textStyles,
  useSpotlightTheme,
  type SegmentedControlItem,
} from '@spotlight/design-system';

import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { TransactionRow } from '@/features/sales/components/transaction-row';
import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAppServices } from '@/providers/app-providers';
import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';

type TransactionFilterKey = 'all' | CardTransactionKind;

const filterItems: readonly SegmentedControlItem<TransactionFilterKey>[] = [
  { label: 'All', value: 'all' },
  { label: 'Bought', value: 'bought' },
  { label: 'Sold', value: 'sold' },
  { label: 'Traded', value: 'traded' },
];

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
  const handleTabBarScroll = useTabBarScrollHandler();

  const [transactions, setTransactions] = useState<CardTransactionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<TransactionFilterKey>('all');

  const loadTransactions = useCallback(async () => {
    try {
      const records = await spotlightRepository.listCardTransactions();
      setTransactions(records);
      setLoadError(null);
    } catch {
      setLoadError('Please try again once your backend is reachable.');
    }
    setHasLoaded(true);
  }, [spotlightRepository]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      await loadTransactions();
      if (!cancelled) {
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dataVersion, loadTransactions]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await loadTransactions();
    } finally {
      setIsRefreshing(false);
    }
  }, [loadTransactions]);

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const showInitialSkeleton = isLoading && !hasLoaded;
  const showInitialError = !isLoading && !isRefreshing && loadError !== null && transactions.length === 0;
  const showEmptyState = !isLoading && !isRefreshing && loadError === null && transactions.length === 0;

  const visibleTransactions = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const searched = normalizedQuery
      ? transactions.filter((transaction) => {
          const haystack = [
            transaction.note,
            transaction.kind,
            (transaction.amountCents / 100).toFixed(2),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(normalizedQuery);
        })
      : transactions;

    if (activeFilter === 'all') {
      return searched;
    }

    return searched.filter((transaction) => transaction.kind === activeFilter);
  }, [activeFilter, searchQuery, transactions]);

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
            Transactions
          </Text>
          <View style={salesStyles.headerSpacer} />
        </View>

        {showInitialSkeleton ? (
          <LatestSalesSkeleton />
        ) : showInitialError ? (
          <StateCard
            message={loadError ?? 'Please try again once your backend is reachable.'}
            style={styles.stateCard}
            title="Could not load transactions"
            variant="field"
          />
        ) : showEmptyState ? (
          <StateCard
            message="Logged buys, sells, and trades will appear here. Tap + to log your first one."
            style={styles.stateCard}
            title="No transactions yet"
          />
        ) : (
          <ScrollView
            contentContainerStyle={salesStyles.scrollContent}
            onScroll={handleTabBarScroll}
            scrollEventThrottle={16}
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
            <Text style={salesStyles.sectionTitle} testID="sales-transactions-title">
              Transactions
            </Text>

            <View style={salesStyles.searchRow}>
              <SearchField
                accessibilityLabel="Search your transactions"
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="while-editing"
                onChangeText={setSearchQuery}
                placeholder="Search your transactions"
                returnKeyType="search"
                size="collection"
                surface="muted"
                value={searchQuery}
              />
            </View>

            <View style={salesStyles.filterRow}>
              <SegmentedControl
                items={filterItems}
                onChange={setActiveFilter}
                testID="sales-kind-filter"
                value={activeFilter}
              />
            </View>

            {visibleTransactions.length === 0 ? (
              <View style={salesStyles.emptyWrap}>
                <StateCard
                  message="Try a different search or filter to find this transaction."
                  title="No transactions match"
                />
              </View>
            ) : (
              <View style={salesStyles.salesList} testID="latest-sales-list">
                {visibleTransactions.map((transaction) => (
                  <TransactionRow
                    key={transaction.id}
                    record={transaction}
                    testID={`latest-transaction-card-${transaction.id}`}
                  />
                ))}
              </View>
            )}
          </ScrollView>
        )}
      </View>

      <CollectionAddFab onPress={() => router.push('/card-transactions/new')} />

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
  filterRow: {
    paddingHorizontal: 16,
  },
  salesList: {
    gap: 0,
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

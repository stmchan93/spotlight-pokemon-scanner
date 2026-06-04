import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Menu as MenuIcon,
  NavArrowDown,
  NavArrowUp,
  ShareIos,
} from 'iconoir-react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CardTransactionKind, CardTransactionRecord } from '@spotlight/api-client';
import {
  IconButton,
  PillButton,
  SearchField,
  StateCard,
  colors,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CollectionAddFab } from '@/features/portfolio/components/collection-add-fab';
import { TransactionRow, TransactionThumb } from '@/features/sales/components/transaction-row';
import {
  groupTransactionsByDay,
  listTransactionYears,
  sortTransactions,
  type TransactionSortDir,
  type TransactionSortKey,
} from '@/features/sales/transaction-grouping';
import { useTabBarScrollHandler } from '@/contexts/tab-bar-chrome-context';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAppServices } from '@/providers/app-providers';
import { AppBottomTabBar } from '@/components/app-bottom-tab-bar';

type TransactionFilterKey = 'all' | CardTransactionKind;

const kindFilters: readonly { label: string; value: TransactionFilterKey }[] = [
  { label: 'All', value: 'all' },
  { label: 'Sold', value: 'sold' },
  { label: 'Purchased', value: 'bought' },
  { label: 'Traded', value: 'traded' },
];

function LatestSalesSkeleton() {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.skeletonList} testID="latest-sales-screen-skeleton">
      {Array.from({ length: 4 }).map((_, index) => (
        <View key={index} style={styles.skeletonCard}>
          <View style={styles.skeletonLeftGroup}>
            <TransactionThumb photoUrl={null} />
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
  const scrollRef = useRef<ScrollView>(null);

  const [transactions, setTransactions] = useState<CardTransactionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<TransactionFilterKey>('all');
  const [sortKey, setSortKey] = useState<TransactionSortKey>('date');
  const [sortDir, setSortDir] = useState<TransactionSortDir>('desc');
  // `null` = follow the most recent year present in the data (default).
  const [year, setYear] = useState<number | null>(null);

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

  const handleSortPress = useCallback((key: TransactionSortKey) => {
    setSortKey((currentKey) => {
      if (currentKey === key) {
        // Same sort tapped again toggles direction.
        setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
        return currentKey;
      }
      // Switching axis resets to the natural default (newest / highest first).
      setSortDir('desc');
      return key;
    });
  }, []);

  const handleBackToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

  const bottomNavClearance =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0);

  const availableYears = useMemo(
    () => listTransactionYears(transactions),
    [transactions],
  );

  // Resolve the active year: explicit selection, else the most recent year.
  const resolvedYear = year ?? availableYears[0] ?? null;

  const showInitialSkeleton = isLoading && !hasLoaded;
  const showInitialError = !isLoading && !isRefreshing && loadError !== null && transactions.length === 0;
  const showEmptyState = !isLoading && !isRefreshing && loadError === null && transactions.length === 0;

  const visibleGroups = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const searched = normalizedQuery
      ? transactions.filter((transaction) => {
          const haystack = [
            transaction.note,
            transaction.kind,
            transaction.amountCents != null
              ? (transaction.amountCents / 100).toFixed(2)
              : null,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(normalizedQuery);
        })
      : transactions;

    const kindFiltered =
      activeFilter === 'all'
        ? searched
        : searched.filter((transaction) => transaction.kind === activeFilter);

    const yearFiltered =
      resolvedYear == null
        ? kindFiltered
        : kindFiltered.filter((transaction) => {
            const parsed = new Date(transaction.occurredAt);
            return !Number.isNaN(parsed.getTime()) && parsed.getFullYear() === resolvedYear;
          });

    const sorted = sortTransactions(yearFiltered, sortKey, sortDir);
    return groupTransactionsByDay(sorted);
  }, [activeFilter, resolvedYear, searchQuery, sortDir, sortKey, transactions]);

  const hasVisibleTransactions = visibleGroups.length > 0;

  const cycleYear = useCallback(() => {
    if (availableYears.length === 0) {
      return;
    }
    const currentIndex = availableYears.indexOf(resolvedYear ?? availableYears[0]);
    const nextIndex = (currentIndex + 1) % availableYears.length;
    setYear(availableYears[nextIndex]);
  }, [availableYears, resolvedYear]);

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
          <IconButton
            accessibilityLabel="Export transactions"
            shape="rounded"
            size={24}
            style={salesStyles.headerExport}
            testID="sales-header-export"
            variant="ghost"
          >
            <ShareIos color={theme.colors.gray900} height={22} width={22} />
          </IconButton>
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
            ref={scrollRef}
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
            <View style={salesStyles.searchRow}>
              <SearchField
                accessibilityLabel="Search your collection"
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="while-editing"
                onChangeText={setSearchQuery}
                placeholder="Search your collection"
                returnKeyType="search"
                size="collection"
                surface="muted"
                value={searchQuery}
              />
            </View>

            <ScrollView
              contentContainerStyle={salesStyles.pillRowContent}
              horizontal
              showsHorizontalScrollIndicator={false}
              testID="sales-filter-pills"
            >
              {kindFilters.map((filter) => (
                <PillButton
                  key={filter.value}
                  label={filter.label}
                  onPress={() => setActiveFilter(filter.value)}
                  selected={activeFilter === filter.value}
                  testID={`sales-filter-${filter.value}`}
                  tone="filter"
                />
              ))}
              <PillButton
                label={sortDirectionLabel('Date', sortKey === 'date', sortDir)}
                onPress={() => handleSortPress('date')}
                selected={sortKey === 'date'}
                testID="sales-sort-date"
                tone="filter"
              />
              <PillButton
                label={sortDirectionLabel('Price', sortKey === 'price', sortDir)}
                onPress={() => handleSortPress('price')}
                selected={sortKey === 'price'}
                testID="sales-sort-price"
                tone="filter"
              />
            </ScrollView>

            {resolvedYear != null ? (
              <View style={salesStyles.yearRow}>
                <Pressable
                  accessibilityLabel={`Year ${resolvedYear}, change year`}
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={cycleYear}
                  style={salesStyles.yearPill}
                  testID="sales-year-pill"
                >
                  <Text style={salesStyles.yearLabel}>{resolvedYear}</Text>
                  <NavArrowDown color={theme.colors.gray900} height={18} width={18} />
                </Pressable>
              </View>
            ) : null}

            {!hasVisibleTransactions ? (
              <View style={salesStyles.emptyWrap}>
                <StateCard
                  message="Try a different search or filter to find this transaction."
                  title="No transactions match"
                />
              </View>
            ) : (
              <View style={salesStyles.salesList} testID="latest-sales-list">
                {visibleGroups.map((group) => (
                  <View key={group.dayKey} testID={`sales-day-group-${group.dayKey}`}>
                    <View style={salesStyles.dayHeaderRow}>
                      <Text style={salesStyles.dayNumber}>{group.dayNumber}</Text>
                      <Text style={salesStyles.dayMonth}>{group.monthLabel}</Text>
                    </View>
                    {group.records.map((transaction, index) => (
                      <TransactionRow
                        key={transaction.id}
                        firstInList={index === 0}
                        record={transaction}
                        testID={`latest-transaction-card-${transaction.id}`}
                      />
                    ))}
                  </View>
                ))}

                <Pressable
                  accessibilityLabel="Back to top"
                  accessibilityRole="button"
                  hitSlop={8}
                  onPress={handleBackToTop}
                  style={salesStyles.backToTop}
                  testID="sales-back-to-top"
                >
                  <NavArrowUp color={theme.colors.gray600} height={18} width={18} />
                  <Text style={salesStyles.backToTopLabel}>Back to top</Text>
                </Pressable>
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

function sortDirectionLabel(base: string, active: boolean, dir: TransactionSortDir) {
  if (!active) {
    return base;
  }
  return `${base} ${dir === 'asc' ? '↑' : '↓'}`;
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
  headerExport: {
    borderWidth: 0,
  },
  scrollContent: {
    gap: 16,
    paddingBottom: 24,
    paddingTop: 8,
  },
  searchRow: {
    paddingHorizontal: 16,
  },
  pillRowContent: {
    gap: 8,
    paddingHorizontal: 16,
  },
  yearRow: {
    paddingHorizontal: 16,
  },
  yearPill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 4,
    paddingVertical: 4,
  },
  yearLabel: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  dayHeaderRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  dayNumber: {
    ...textStyles.titleMedium,
    color: colors.gray900,
  },
  dayMonth: {
    ...textStyles.overline,
    color: colors.gray600,
  },
  salesList: {
    gap: 0,
  },
  backToTop: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    paddingVertical: 20,
  },
  backToTopLabel: {
    ...textStyles.overline,
    color: colors.gray600,
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

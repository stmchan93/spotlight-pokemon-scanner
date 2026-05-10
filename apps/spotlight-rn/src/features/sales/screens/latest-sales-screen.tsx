import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ArrowDown, ArrowUp, NavArrowLeft } from 'iconoir-react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RecentSaleRecord } from '@spotlight/api-client';
import {
  StateCard,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { getCardImageSource } from '@/lib/card-images';
import { useAppServices } from '@/providers/app-providers';

const PAGE_GUTTER = 16;

function formattedCardNumber(cardNumber: string) {
  return cardNumber.startsWith('#') ? cardNumber : `#${cardNumber}`;
}

function formatSaleActionLabel(sale: RecentSaleRecord) {
  // Strip any verb the backend already prepended so we don't end up
  // with strings like "Sold on Traded on May 3, 2026".
  const dateOnly = sale.soldAtLabel.replace(/^(Sold on|Traded on)\s+/i, '');
  const verb = sale.kind === 'traded' ? 'Traded' : 'Sold';
  return `${verb} on ${dateOnly}`;
}

// Future-state delta data not yet on RecentSaleRecord; keep null until backend
// surfaces gain/loss for sold inventory. JSX below already wires the pill.
type LatestSaleGain = {
  amountLabel: string;
  direction: 'up' | 'down';
} | null;

function getLatestSaleGain(_sale: RecentSaleRecord): LatestSaleGain {
  return null;
}

function LatestSaleRow({ sale }: { sale: RecentSaleRecord }) {
  const theme = useSpotlightTheme();
  const cardHeight = theme.layout.recentSaleHeight;
  const cardPadding = theme.spacing.xxs;
  const artHeight = cardHeight - cardPadding * 2;
  const gain = getLatestSaleGain(sale);

  return (
    <Pressable
      style={styles.cardPressable}
      testID={`latest-sale-card-${sale.id}`}
    >
      <SurfaceCard padding={cardPadding} radius={16} style={[styles.card, { minHeight: cardHeight }]}>
        <CachedImage
          cachePolicy={imageCachePolicy.thumbnail}
          contentFit="contain"
          source={getCardImageSource(sale, 'small')}
          style={[styles.art, { height: artHeight }]}
        />

        <View style={[styles.copy, { minHeight: artHeight }]}>
          <View style={styles.topRow}>
            <Text
              numberOfLines={1}
              style={[theme.typography.headline, styles.titleText, { color: theme.colors.textPrimary }]}
            >
              {sale.name}
            </Text>
            <Text
              style={[theme.typography.headline, { color: theme.colors.textPrimary }]}
            >
              {formatCurrency(sale.soldPrice, sale.currencyCode)}
            </Text>
          </View>
          <View style={styles.metaRow}>
            <Text
              numberOfLines={2}
              style={[theme.typography.cardMeta, styles.metaText, { color: theme.colors.textMuted }]}
            >
              {formattedCardNumber(sale.cardNumber)}
              {' · '}
              {sale.setName}
            </Text>
            {gain ? (
              <View style={styles.deltaInline}>
                {gain.direction === 'down' ? (
                  <ArrowDown color={theme.colors.redDelta} height={12} width={12} />
                ) : (
                  <ArrowUp color={theme.colors.greenDelta} height={12} width={12} />
                )}
                <Text
                  style={[
                    theme.typography.deltaPill,
                    {
                      color:
                        gain.direction === 'down'
                          ? theme.colors.redDelta
                          : theme.colors.greenDelta,
                    },
                  ]}
                >
                  {gain.amountLabel}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[theme.typography.overline, styles.soldOn, { color: theme.colors.textMuted }]}>
            {formatSaleActionLabel(sale)}
          </Text>
        </View>
      </SurfaceCard>
    </Pressable>
  );
}

function LatestSalesSkeleton() {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.list} testID="latest-sales-screen-skeleton">
      {Array.from({ length: 4 }).map((_, index) => (
        <SurfaceCard
          key={index}
          padding={8}
          radius={16}
          style={[styles.card, { minHeight: theme.layout.recentSaleHeight }]}
        >
          <View
            style={[
              styles.skeletonArt,
              {
                backgroundColor: theme.colors.outlineSubtle,
                height: theme.layout.recentSaleHeight - 16,
              },
            ]}
          />
          <View style={[styles.copy, { minHeight: theme.layout.recentSaleHeight - 16 }]}>
            <View style={[styles.skeletonLineWide, { backgroundColor: theme.colors.outlineSubtle }]} />
            <View style={[styles.skeletonLineMedium, { backgroundColor: theme.colors.outlineSubtle }]} />
            <View style={[styles.skeletonLineNarrow, { backgroundColor: theme.colors.outlineSubtle }]} />
          </View>
        </SurfaceCard>
      ))}
    </View>
  );
}

export function LatestSalesScreen() {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { spotlightRepository, dataVersion } = useAppServices();

  const [sales, setSales] = useState<RecentSaleRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const showInitialSkeleton = isLoading && !hasLoaded;
  const showInitialError = !isLoading && !isRefreshing && loadError !== null && sales.length === 0;
  const showEmptyState = !isLoading && !isRefreshing && loadError === null && sales.length === 0;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.canvas }]}
    >
      <View style={[styles.screen, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.navRow}>
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => router.back()}
            style={styles.backButton}
            testID="latest-sales-back"
          >
            <NavArrowLeft color={theme.colors.textPrimary} height={24} width={24} />
          </Pressable>
        </View>
        <View style={styles.headerCopy}>
          <Text style={theme.typography.display}>Latest Sales</Text>
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
          <FlatList
            contentContainerStyle={styles.scrollContent}
            data={sales}
            keyExtractor={(sale) => sale.id}
            refreshControl={(
              <RefreshControl
                onRefresh={handleRefresh}
                refreshing={isRefreshing}
                testID="latest-sales-refresh"
                tintColor={theme.colors.textSecondary}
              />
            )}
            renderItem={({ item }) => <LatestSaleRow sale={item} />}
            showsVerticalScrollIndicator={false}
            testID="latest-sales-list"
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  art: {
    borderRadius: 12,
    resizeMode: 'contain',
    width: 72,
  },
  card: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  cardPressable: {
    borderRadius: 16,
  },
  copy: {
    flex: 1,
    gap: 4,
    justifyContent: 'flex-start',
  },
  deltaInline: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: 2,
  },
  deltaPill: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  metaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  metaText: {
    flex: 1,
    flexShrink: 1,
  },
  soldOn: {
    alignSelf: 'stretch',
    marginTop: 12,
  },
  titleText: {
    flex: 1,
    flexShrink: 1,
  },
  topRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  backButton: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  navRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  headerCopy: {
    gap: 4,
  },
  list: {
    gap: 12,
  },
  priceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  safeArea: {
    flex: 1,
  },
  screen: {
    flex: 1,
    gap: 18,
    paddingHorizontal: PAGE_GUTTER,
    paddingTop: 8,
  },
  scrollContent: {
    gap: 18,
    paddingBottom: 120,
  },
  skeletonArt: {
    borderRadius: 12,
    width: 72,
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
    paddingVertical: 20,
  },
  titleLine: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 8,
  },
});

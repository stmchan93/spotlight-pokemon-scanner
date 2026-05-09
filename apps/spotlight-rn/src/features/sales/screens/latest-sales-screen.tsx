import { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RecentSaleRecord } from '@spotlight/api-client';
import {
  StateCard,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { ChromeBackButton } from '@/components/chrome-back-button';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { getCardImageSource } from '@/lib/card-images';
import { useAppServices } from '@/providers/app-providers';

type LatestSalesScreenProps = {
  onBack: () => void;
};

const PAGE_GUTTER = 16;

function formattedCardNumber(cardNumber: string) {
  return cardNumber.startsWith('#') ? cardNumber : `#${cardNumber}`;
}

function LatestSaleRow({ sale }: { sale: RecentSaleRecord }) {
  const theme = useSpotlightTheme();
  const cardHeight = theme.layout.recentSaleHeight;
  const cardPadding = theme.spacing.xxs;
  const artHeight = cardHeight - cardPadding * 2;

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
          <View style={styles.titleRow}>
            <Text
              numberOfLines={1}
              style={[theme.typography.headline, styles.titleText, { color: theme.colors.textPrimary }]}
            >
              {sale.name}
            </Text>
            <Text style={[theme.typography.headline, styles.priceText, { color: theme.colors.textPrimary }]}>
              {formatCurrency(sale.soldPrice, sale.currencyCode)}
            </Text>
          </View>
          <Text numberOfLines={2} style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {formattedCardNumber(sale.cardNumber)}
            {' • '}
            {sale.setName}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
            {sale.soldAtLabel}
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

export function LatestSalesScreen({ onBack }: LatestSalesScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
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
          <ChromeBackButton onPress={onBack} testID="latest-sales-back" />
          <Text style={[theme.typography.headline, { color: theme.colors.textSecondary }]}>Sales</Text>
          <View style={styles.navSpacer} />
        </View>

        <View style={styles.headerCopy}>
          <View style={styles.titleLine}>
            <Text style={theme.typography.display}>Latest Sales</Text>
            {sales.length > 0 ? (
              <Text
                style={[theme.typography.headline, { color: theme.colors.textSecondary }]}
                testID="latest-sales-count"
              >
                ({sales.length})
              </Text>
            ) : null}
          </View>
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={(
            <RefreshControl
              onRefresh={handleRefresh}
              refreshing={isRefreshing}
              testID="latest-sales-refresh"
              tintColor={theme.colors.textSecondary}
            />
          )}
          showsVerticalScrollIndicator={false}
          testID="latest-sales-scroll"
        >
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
            <View style={styles.list}>
              {sales.map((sale) => (
                <LatestSaleRow key={sale.id} sale={sale} />
              ))}
            </View>
          )}
        </ScrollView>
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
    gap: 6,
    justifyContent: 'center',
  },
  headerCopy: {
    gap: 4,
  },
  list: {
    gap: 12,
  },
  navRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  navSpacer: {
    width: 44,
  },
  priceText: {
    flexShrink: 0,
    textAlign: 'right',
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
  titleRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    width: '100%',
  },
  titleText: {
    flex: 1,
  },
});

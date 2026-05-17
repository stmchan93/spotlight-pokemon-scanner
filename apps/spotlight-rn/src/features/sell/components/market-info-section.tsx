import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type {
  CardDetailRecord,
  CardRecentSalesRecord,
  InventoryCardEntry,
} from '@spotlight/api-client';
import {
  Button,
  SurfaceCard,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { useAppServices } from '@/providers/app-providers';

type MarketInfoSectionProps = {
  entry: InventoryCardEntry;
};

function buildTcgPlayerSearchUrl(params: { cardNumber: string; name: string; setName: string }) {
  const tokens = [
    params.name,
    params.cardNumber.replace(/^#/, ''),
    params.setName,
  ]
    .map((value) => value.replace(/[^A-Za-z0-9 ]+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
  if (!tokens) return null;
  const search = new URLSearchParams({ q: tokens, view: 'grid' });
  return `https://www.tcgplayer.com/search/pokemon/product?${search.toString()}`;
}

function formatCurrency(amount: number, currencyCode: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode || 'USD',
  }).format(amount);
}

export function MarketInfoSection({ entry }: MarketInfoSectionProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository } = useAppServices();
  const [detail, setDetail] = useState<CardDetailRecord | null>(null);
  const [recentSales, setRecentSales] = useState<CardRecentSalesRecord | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(true);
  const [isLoadingSales, setIsLoadingSales] = useState(false);
  const [hasRequestedSales, setHasRequestedSales] = useState(false);
  const isSlab = entry.kind === 'graded';

  useEffect(() => {
    let cancelled = false;
    setIsLoadingDetail(true);
    void spotlightRepository
      .getCardDetail({
        cardId: entry.cardId,
        slabContext: entry.slabContext ?? null,
      })
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
      })
      .catch(() => {
        if (cancelled) return;
        setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.cardId, entry.slabContext, spotlightRepository]);

  const handleLoadEbaySales = useCallback(() => {
    if (isLoadingSales) return;
    setIsLoadingSales(true);
    setHasRequestedSales(true);
    void spotlightRepository
      .getCardRecentSales({
        cardId: entry.cardId,
        slabContext: entry.slabContext ?? null,
        limit: 5,
      })
      .then((next) => {
        setRecentSales(next);
      })
      .catch(() => {
        setRecentSales(null);
      })
      .finally(() => {
        setIsLoadingSales(false);
      });
  }, [entry.cardId, entry.slabContext, isLoadingSales, spotlightRepository]);

  const marketPrice = detail?.marketHistory?.currentPrice ?? entry.marketPrice ?? null;
  const currencyCode = detail?.marketHistory?.currencyCode ?? entry.currencyCode ?? 'USD';
  const conditionOptions = detail?.marketHistory?.availableConditions ?? [];
  const tcgUrl = !isSlab
    ? buildTcgPlayerSearchUrl({
        cardNumber: entry.cardNumber,
        name: entry.name,
        setName: entry.setName,
      })
    : null;

  return (
    <SurfaceCard padding={18} radius={24} style={styles.card} testID="single-sell-market-info">
      {isLoadingDetail && marketPrice == null ? (
        <ActivityIndicator color={colors.brand} style={styles.spinner} />
      ) : null}

      {marketPrice != null ? (
        <>
          <Text style={[theme.typography.display, styles.priceValue]} testID="single-sell-market-price">
            {formatCurrency(marketPrice, currencyCode)}
          </Text>
          <Text style={[theme.typography.caption, styles.priceCaption]}>
            Market avg.
          </Text>
        </>
      ) : null}

      {!isSlab && conditionOptions.length > 0 ? (
        <View style={styles.chipsRow} testID="single-sell-condition-chips">
          {conditionOptions.map((option) => (
            <View key={option.id} style={styles.conditionChip}>
              <Text style={[theme.typography.caption, styles.conditionChipShort]}>
                {option.label?.slice(0, 2).toUpperCase() ?? option.id}
              </Text>
              <Text style={[theme.typography.bodyStrong, styles.conditionChipPrice]}>
                {option.currentPrice != null
                  ? formatCurrency(option.currentPrice, currencyCode)
                  : '—'}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {isSlab ? (
        <View style={styles.salesBlock} testID="single-sell-ebay-sales">
          <Text style={[theme.typography.caption, styles.salesHeader]}>
            Recent sales (eBay)
          </Text>
          {!hasRequestedSales ? (
            <Button
              disabled={isLoadingSales}
              label={isLoadingSales ? 'Loading…' : 'Load eBay sales'}
              onPress={handleLoadEbaySales}
              size="lg"
              style={styles.loadSalesButton}
              testID="single-sell-load-ebay-sales"
              variant="secondary"
            />
          ) : recentSales?.sales && recentSales.sales.length > 0 ? (
            recentSales.sales.slice(0, 3).map((sale) => (
              <View key={sale.id} style={styles.salesRow}>
                <Text style={[theme.typography.caption, styles.salesRowTitle]} numberOfLines={1}>
                  {sale.title}
                </Text>
                <Text style={[theme.typography.bodyStrong, styles.salesRowPrice]}>
                  {sale.priceAmount != null
                    ? formatCurrency(sale.priceAmount, sale.currencyCode)
                    : '—'}
                </Text>
              </View>
            ))
          ) : (
            <Text style={[theme.typography.caption, styles.salesHeader]}>
              No recent eBay sales found.
            </Text>
          )}
        </View>
      ) : null}

      {tcgUrl ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void Linking.openURL(tcgUrl)}
          style={({ pressed }) => [styles.tcgRow, pressed ? styles.tcgRowPressed : null]}
          testID="single-sell-tcgplayer-link"
        >
          <Text style={[theme.typography.bodyStrong, styles.tcgRowLabel]}>
            See on TCGplayer ↗
          </Text>
        </Pressable>
      ) : null}
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.98)',
    gap: 8,
    marginTop: 12,
  },
  chipsRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 8,
    width: '100%',
  },
  conditionChip: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    flex: 1,
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  conditionChipPrice: {
    color: colors.textPrimary,
  },
  conditionChipShort: {
    color: colors.textSecondary,
    marginBottom: 2,
  },
  priceCaption: {
    color: colors.textSecondary,
  },
  priceValue: {
    color: colors.textPrimary,
  },
  loadSalesButton: {
    alignSelf: 'stretch',
    marginTop: 4,
  },
  salesBlock: {
    gap: 6,
    marginTop: 8,
    width: '100%',
  },
  salesHeader: {
    color: colors.textSecondary,
  },
  salesRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  salesRowPrice: {
    color: colors.textPrimary,
  },
  salesRowTitle: {
    color: colors.textPrimary,
    flex: 1,
  },
  spinner: {
    paddingVertical: 12,
  },
  tcgRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    width: '100%',
  },
  tcgRowLabel: {
    color: colors.textPrimary,
  },
  tcgRowPressed: {
    opacity: 0.72,
  },
});

export default MarketInfoSection;

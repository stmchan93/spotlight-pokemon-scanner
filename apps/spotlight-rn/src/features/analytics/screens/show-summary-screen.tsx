import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { VendorShowSummary } from '@spotlight/api-client';
import {
  SurfaceCard,
  colors,
  textStyles,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { ChromeBackButton } from '@/components/chrome-back-button';
import { useAppServices } from '@/providers/app-providers';

type ShowSummaryScreenProps = {
  onBack: () => void;
};

const RANGE_OPTIONS = [
  { label: 'Today', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
] as const;

function formatCurrency(amount: number, currencyCode: string | null) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode ?? 'USD',
  }).format(amount);
}

export function ShowSummaryScreen({ onBack }: ShowSummaryScreenProps) {
  const { spotlightRepository } = useAppServices();
  const [summary, setSummary] = useState<VendorShowSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rangeHours, setRangeHours] = useState<number>(24);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    const until = new Date();
    const since = new Date(until.getTime() - rangeHours * 60 * 60 * 1000);
    void spotlightRepository
      .getVendorShowSummary({
        since: since.toISOString(),
        until: until.toISOString(),
      })
      .then((result) => {
        if (cancelled) {
          return;
        }
        setSummary(result);
      })
      .catch((failure) => {
        if (cancelled) {
          return;
        }
        setError(failure instanceof Error ? failure.message : 'Failed to load summary');
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rangeHours, spotlightRepository]);

  const currencyCode = summary?.currencyCode ?? null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.headerRow}>
        <ChromeBackButton onPress={onBack} />
        <Text style={styles.headerTitle}>Show summary</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.rangeRow}>
        {RANGE_OPTIONS.map((option) => (
          <Pressable
            accessibilityLabel={`View ${option.label} summary`}
            key={option.label}
            onPress={() => setRangeHours(option.hours)}
            style={({ pressed }) => [
              styles.rangeChip,
              rangeHours === option.hours ? styles.rangeChipActive : null,
              pressed ? styles.rangeChipPressed : null,
            ]}
          >
            <Text
              style={[
                styles.rangeChipLabel,
                rangeHours === option.hours ? styles.rangeChipLabelActive : null,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {isLoading ? (
          <ActivityIndicator color={colors.brand} style={styles.spinner} />
        ) : error ? (
          <SurfaceCard style={styles.card}>
            <Text style={styles.errorText}>{error}</Text>
          </SurfaceCard>
        ) : summary ? (
          <>
            <SurfaceCard style={styles.card}>
              <Text style={styles.statLabel}>Revenue</Text>
              <Text style={styles.statValue}>
                {formatCurrency(summary.totalRevenue, currencyCode)}
              </Text>
              <Text style={styles.statMeta}>
                {summary.totalSales} {summary.totalSales === 1 ? 'sale' : 'sales'}
              </Text>
            </SurfaceCard>

            {summary.byPaymentMethod.length > 0 ? (
              <SurfaceCard style={styles.card}>
                <Text style={styles.sectionTitle}>By payment method</Text>
                {summary.byPaymentMethod.map((bucket) => (
                  <View
                    key={bucket.paymentMethod ?? 'unknown'}
                    style={styles.paymentRow}
                    testID={`show-summary-method-${bucket.paymentMethod ?? 'unknown'}`}
                  >
                    <Text style={styles.paymentMethod}>
                      {bucket.paymentMethod ?? 'Other'}
                    </Text>
                    <View style={styles.paymentValues}>
                      <Text style={styles.paymentRevenue}>
                        {formatCurrency(bucket.revenue, currencyCode)}
                      </Text>
                      <Text style={styles.paymentCount}>
                        {bucket.count} {bucket.count === 1 ? 'sale' : 'sales'}
                      </Text>
                    </View>
                  </View>
                ))}
              </SurfaceCard>
            ) : null}

            {summary.topCards.length > 0 ? (
              <SurfaceCard style={styles.card}>
                <Text style={styles.sectionTitle}>Top cards</Text>
                {summary.topCards.map((card, index) => (
                  <View key={card.cardID} style={styles.topCardRow}>
                    <Text style={styles.topCardRank}>{index + 1}</Text>
                    {card.imageUrl ? (
                      <CachedImage
                        cachePolicy={imageCachePolicy.thumbnail}
                        source={{ uri: card.imageUrl }}
                        style={styles.topCardImage}
                      />
                    ) : (
                      <View style={[styles.topCardImage, styles.topCardImagePlaceholder]} />
                    )}
                    <View style={styles.topCardCopy}>
                      <Text style={styles.topCardName} numberOfLines={1}>
                        {card.name}
                      </Text>
                      <Text style={styles.topCardMeta} numberOfLines={1}>
                        {card.setName ?? ''}
                      </Text>
                    </View>
                    <Text style={styles.topCardRevenue}>
                      {formatCurrency(card.totalPrice, currencyCode)}
                    </Text>
                  </View>
                ))}
              </SurfaceCard>
            ) : null}

            {summary.totalSales === 0 ? (
              <SurfaceCard style={styles.card}>
                <Text style={styles.emptyText}>
                  No sales recorded in this range yet.
                </Text>
              </SurfaceCard>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 16,
  },
  emptyText: {
    ...textStyles.body,
    color: colors.textSecondary,
  },
  errorText: {
    ...textStyles.body,
    color: colors.danger,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 48,
    paddingHorizontal: 12,
  },
  headerSpacer: {
    width: 40,
  },
  headerTitle: {
    ...textStyles.headline,
    color: colors.textPrimary,
    flex: 1,
    textAlign: 'center',
  },
  paymentCount: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  paymentMethod: {
    ...textStyles.body,
    color: colors.textPrimary,
    textTransform: 'capitalize',
  },
  paymentRevenue: {
    ...textStyles.body,
    color: colors.textPrimary,
  },
  paymentRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  paymentValues: {
    alignItems: 'flex-end',
  },
  rangeChip: {
    borderColor: colors.outlineSubtle,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  rangeChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  rangeChipLabel: {
    ...textStyles.control,
    color: colors.textPrimary,
  },
  rangeChipLabelActive: {
    color: '#000000',
  },
  rangeChipPressed: {
    opacity: 0.86,
  },
  rangeRow: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 8,
    paddingHorizontal: 16,
  },
  safeArea: {
    backgroundColor: colors.canvas,
    flex: 1,
  },
  scrollContent: {
    gap: 12,
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    ...textStyles.headline,
    color: colors.textPrimary,
    marginBottom: 8,
  },
  spinner: {
    marginTop: 24,
  },
  statLabel: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  statMeta: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginTop: 4,
  },
  statValue: {
    ...textStyles.display,
    color: colors.textPrimary,
    marginTop: 4,
  },
  topCardCopy: {
    flex: 1,
    gap: 2,
  },
  topCardImage: {
    borderRadius: 6,
    height: 56,
    width: 40,
  },
  topCardImagePlaceholder: {
    backgroundColor: colors.surface,
  },
  topCardMeta: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  topCardName: {
    ...textStyles.body,
    color: colors.textPrimary,
  },
  topCardRank: {
    ...textStyles.headline,
    color: colors.textMuted,
    width: 20,
  },
  topCardRevenue: {
    ...textStyles.body,
    color: colors.textPrimary,
  },
  topCardRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 8,
  },
});

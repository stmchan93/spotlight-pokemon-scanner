import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ArrowDown, ArrowUp, EditPencil } from 'iconoir-react-native';

import type { RecentSaleRecord } from '@spotlight/api-client';
import {
  SectionHeader,
  StateCard,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { getCardImageSource } from '@/lib/card-images';
import { formatCurrency } from './portfolio-formatting';

// Future-state delta data not yet on RecentSaleRecord; keep null until backend
// surfaces gain/loss for sold inventory. JSX below already wires the pill.
type RecentSaleGain = {
  amountLabel: string;
  direction: 'up' | 'down';
} | null;

function getRecentSaleGain(_sale: RecentSaleRecord): RecentSaleGain {
  return null;
}

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

function RecentSaleCard({
  onPress,
  sale,
}: {
  onPress?: (sale: RecentSaleRecord) => void;
  sale: RecentSaleRecord;
}) {
  const theme = useSpotlightTheme();
  const canEdit = sale.kind === 'sold' && !!onPress;
  const cardHeight = theme.layout.recentSaleHeight;
  const cardPadding = theme.spacing.xxs;
  const artHeight = cardHeight - cardPadding * 2;
  const gain = getRecentSaleGain(sale);

  return (
    <Pressable
      accessibilityRole={canEdit ? 'button' : undefined}
      onPress={canEdit ? () => onPress?.(sale) : undefined}
      style={({ pressed }) => [styles.cardPressable, canEdit ? { opacity: pressed ? 0.94 : 1 } : null]}
      testID={`recent-sale-card-${sale.id}`}
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
              style={[theme.typography.label, styles.metaText, { color: theme.colors.gray600 }]}
            >
              {formattedCardNumber(sale.cardNumber)}
              {' · '}
              {sale.setName}
            </Text>
            {gain ? (
              <View style={styles.deltaInline}>
                {gain.direction === 'down' ? (
                  <ArrowDown color={theme.colors.deltaDownText} height={12} width={12} />
                ) : (
                  <ArrowUp color={theme.colors.deltaUpText} height={12} width={12} />
                )}
                <Text
                  style={[
                    theme.typography.deltaPill,
                    {
                      color:
                        gain.direction === 'down'
                          ? theme.colors.deltaDownText
                          : theme.colors.deltaUpText,
                    },
                  ]}
                >
                  {gain.amountLabel}
                </Text>
              </View>
            ) : null}
          </View>
          {sale.qualityLabel ? (
            <Text
              numberOfLines={1}
              style={[theme.typography.label, { color: theme.colors.gray600 }]}
            >
              {sale.qualityLabel}
            </Text>
          ) : null}
          {sale.quantity != null ? (
            <Text
              numberOfLines={1}
              style={[theme.typography.label, { color: theme.colors.gray600 }]}
            >
              {`Qty: ${sale.quantity}`}
            </Text>
          ) : null}
          <View style={styles.soldOnRow}>
            <Text
              style={[theme.typography.overline, styles.soldOnText, { color: theme.colors.textMuted }]}
            >
              {formatSaleActionLabel(sale)}
            </Text>
            {canEdit ? (
              <EditPencil
                color={theme.colors.textMuted}
                height={16}
                testID={`recent-sale-card-${sale.id}-edit-icon`}
                width={16}
              />
            ) : null}
          </View>
        </View>
      </SurfaceCard>
    </Pressable>
  );
}

type RecentSalesSectionProps = {
  expanded: boolean;
  isLoading?: boolean;
  onOpenSalesHistory?: () => void;
  onSalePress?: (sale: RecentSaleRecord) => void;
  /**
   * Optional. When provided, the SectionHeader renders the legacy
   * expand/collapse chevron. The Recent Sales tab in the redesigned
   * Portfolio surface omits this so no chevron renders.
   */
  onToggleExpanded?: () => void;
  sales: RecentSaleRecord[];
  title?: string;
};

function RecentSalesSkeleton() {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.list} testID="latest-sales-skeleton">
      {Array.from({ length: 3 }).map((_, index) => (
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

export function RecentSalesSection({
  expanded,
  isLoading = false,
  onOpenSalesHistory,
  onSalePress,
  onToggleExpanded,
  sales,
  title = 'Latest Sales',
}: RecentSalesSectionProps) {
  const showSubtitle = sales.length === 0 && !isLoading;
  const showSeeMore = sales.length > 0 && onOpenSalesHistory;

  return (
    <View style={styles.section}>
      <SectionHeader
        actionLabel={showSeeMore ? 'View All' : undefined}
        actionTestID="latest-sales-see-more"
        expanded={expanded}
        onActionPress={showSeeMore ? onOpenSalesHistory : undefined}
        onPress={onToggleExpanded}
        subtitle={showSubtitle ? 'Completed transactions will show up here.' : undefined}
        title={title}
      />{/* When onToggleExpanded is undefined (default in the new Portfolio
            tabs), SectionHeader hides the legacy expand/collapse chevron. */}

      {expanded ? (
        sales.length === 0 && isLoading ? (
          <RecentSalesSkeleton />
        ) : sales.length === 0 ? (
          <StateCard
            message="Completed transactions will appear here as soon as you start moving inventory."
            style={styles.emptyStateCard}
            title="No transactions yet"
          />
        ) : (
          <View style={styles.list}>
            {sales.map((sale) => {
              return <RecentSaleCard key={sale.id} onPress={onSalePress} sale={sale} />;
            })}
          </View>
        )
      ) : null}
    </View>
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
    gap: 2,
    flexShrink: 0,
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
  soldOnRow: {
    alignItems: 'center',
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    marginTop: 12,
  },
  soldOnText: {
    flex: 1,
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
  emptyStateCard: {
    marginTop: 16,
  },
  list: {
    gap: 12,
    marginTop: 16,
  },
  priceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  section: {
    gap: 0,
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
});

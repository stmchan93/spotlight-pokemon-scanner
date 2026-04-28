import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { RecentSaleRecord } from '@spotlight/api-client';
import {
  SectionHeader,
  StateCard,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { formatCurrency } from './portfolio-formatting';

function formattedCardNumber(cardNumber: string) {
  return cardNumber.startsWith('#') ? cardNumber : `#${cardNumber}`;
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

  return (
    <Pressable
      accessibilityRole={canEdit ? 'button' : undefined}
      onPress={canEdit ? () => onPress?.(sale) : undefined}
      style={({ pressed }) => [styles.cardPressable, canEdit ? { opacity: pressed ? 0.94 : 1 } : null]}
      testID={`recent-sale-card-${sale.id}`}
    >
      <SurfaceCard padding={cardPadding} radius={16} style={[styles.card, { minHeight: cardHeight }]}>
        <Image source={{ uri: sale.imageUrl }} style={[styles.art, { height: artHeight }]} />

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
          <View style={styles.detailRow}>
            <Text style={[theme.typography.caption, styles.date, { color: theme.colors.textSecondary }]}>
              {sale.soldAtLabel}
            </Text>
            {sale.kind === 'sold' ? (
              <Text style={[theme.typography.caption, styles.icon, { color: theme.colors.textSecondary }]}>
                ✎
              </Text>
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
  onToggleExpanded: () => void;
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
      />

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
    gap: 6,
    justifyContent: 'center',
  },
  date: {
    flex: 1,
  },
  detailRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  emptyStateCard: {
    marginTop: 16,
  },
  icon: {
    marginTop: 1,
  },
  list: {
    gap: 12,
    marginTop: 16,
  },
  section: {
    gap: 0,
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
  priceText: {
    flexShrink: 0,
    textAlign: 'right',
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

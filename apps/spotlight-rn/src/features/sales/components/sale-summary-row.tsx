import { Pressable, StyleSheet, Text, View } from 'react-native';
import { EditPencil } from 'iconoir-react-native';

import type { RecentSaleRecord } from '@spotlight/api-client';
import {
  TrendPill,
  colors,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { getCardImageSource } from '@/lib/card-images';

export function formattedCardNumber(cardNumber: string) {
  return cardNumber.startsWith('#') ? cardNumber : `#${cardNumber}`;
}

export function formatSaleActionLabel(sale: RecentSaleRecord) {
  // Strip any verb the backend already prepended so we don't end up
  // with strings like "Sold on Traded on May 3, 2026".
  const dateOnly = sale.soldAtLabel.replace(/^(Sold on|Traded on)\s+/i, '');
  const verb = sale.kind === 'traded' ? 'Traded' : 'Sold';
  return `${verb} on ${dateOnly}`;
}

type SaleGain = {
  amountLabel: string;
  direction: 'up' | 'down' | 'flat';
} | null;

export function getSaleGain(sale: RecentSaleRecord): SaleGain {
  if (sale.profit == null) return null;
  const direction: 'up' | 'down' | 'flat' =
    sale.profit > 0 ? 'up' : sale.profit < 0 ? 'down' : 'flat';
  return {
    amountLabel: formatCurrency(Math.abs(sale.profit), sale.currencyCode),
    direction,
  };
}

type SaleSummaryRowProps = {
  sale: RecentSaleRecord;
  onPress?: (sale: RecentSaleRecord) => void;
  showEditAffordance?: boolean;
  testID?: string;
};

export function SaleSummaryRow({
  sale,
  onPress,
  showEditAffordance = false,
  testID,
}: SaleSummaryRowProps) {
  const theme = useSpotlightTheme();
  const gain = getSaleGain(sale);
  const resolvedTestID = testID ?? `sale-summary-row-${sale.id}`;
  const pressable = onPress != null;

  const body = (
    <View style={styles.card}>
      <View style={styles.leftGroup}>
        <CachedImage
          cachePolicy={imageCachePolicy.thumbnail}
          contentFit="cover"
          source={getCardImageSource(sale, 'small')}
          style={styles.art}
        />
        <View style={styles.textColumn}>
          <View style={styles.details}>
            <Text
              numberOfLines={1}
              style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}
            >
              {sale.name}
            </Text>
            <Text
              numberOfLines={1}
              style={[styles.metaText, { color: theme.colors.gray600 }]}
            >
              {`${formattedCardNumber(sale.cardNumber)} · ${sale.setName}`}
            </Text>
            {sale.qualityLabel ? (
              <Text
                numberOfLines={1}
                style={[styles.metaText, { color: theme.colors.gray600 }]}
              >
                {sale.qualityLabel}
              </Text>
            ) : null}
            {sale.quantity != null ? (
              <Text
                numberOfLines={1}
                style={[styles.metaText, { color: theme.colors.gray600 }]}
              >
                {`Qty: ${sale.quantity}`}
              </Text>
            ) : null}
          </View>
          <Text
            numberOfLines={1}
            style={[styles.dateText, { color: theme.colors.gray800 }]}
          >
            {formatSaleActionLabel(sale)}
          </Text>
        </View>
      </View>
      <View style={styles.priceColumn}>
        <View style={styles.priceStack}>
          <Text
            style={[theme.typography.titleSmall, styles.priceText, { color: theme.colors.gray900 }]}
          >
            {formatCurrency(sale.soldPrice, sale.currencyCode)}
          </Text>
          {gain ? (
            <TrendPill
              direction={gain.direction}
              label={gain.amountLabel}
              size="sm"
              testID={`${resolvedTestID}-delta`}
            />
          ) : null}
        </View>
        {showEditAffordance ? (
          <EditPencil
            color={theme.colors.gray900}
            height={20}
            testID={`${resolvedTestID}-edit-icon`}
            width={20}
          />
        ) : null}
      </View>
    </View>
  );

  if (!pressable) {
    return (
      <View style={styles.cardWrapper} testID={resolvedTestID}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPress!(sale)}
      style={({ pressed }) => [styles.cardWrapper, { opacity: pressed ? 0.94 : 1 }]}
      testID={resolvedTestID}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cardWrapper: {
    borderRadius: 12,
  },
  card: {
    alignItems: 'flex-start',
    backgroundColor: colors.gray50,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
  },
  leftGroup: {
    alignItems: 'center',
    alignSelf: 'stretch',
    flex: 1,
    flexDirection: 'row',
    gap: 16,
    minWidth: 0,
  },
  art: {
    aspectRatio: 88 / 128,
    borderRadius: 6,
    height: 94,
  },
  textColumn: {
    alignSelf: 'stretch',
    flex: 1,
    justifyContent: 'space-between',
    minWidth: 0,
  },
  details: {
    alignItems: 'flex-start',
    gap: 2,
  },
  metaText: {
    ...textStyles.cardMeta,
  },
  dateText: {
    ...textStyles.overline,
  },
  priceColumn: {
    alignItems: 'flex-end',
    alignSelf: 'stretch',
    justifyContent: 'space-between',
    width: 68,
  },
  priceStack: {
    alignItems: 'flex-end',
    gap: 4,
  },
  priceText: {
    textAlign: 'center',
  },
});

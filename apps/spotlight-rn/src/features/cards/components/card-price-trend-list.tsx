import { Fragment } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';
import type { CardPriceTrendList as CardPriceTrendListType } from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

import { PriceSparkline } from './price-sparkline';

type CardPriceTrendListProps = {
  list: CardPriceTrendListType;
  testID?: string;
};

const SPARKLINE_WIDTH = 62;
const SPARKLINE_HEIGHT = 22;

export function CardPriceTrendList({ list, testID }: CardPriceTrendListProps) {
  const theme = useSpotlightTheme();
  const logoSource =
    list.provider === 'ebay'
      ? require('../../../../assets/images/ebay-logo.png')
      : require('../../../../assets/images/tcgplayer-logo.png');
  const providerLabel = list.provider === 'ebay' ? 'eBay' : 'TCGplayer';
  // Official brand logos at the Figma PDP sizes: eBay 50×20 (992-7804),
  // TCGplayer 27×20 (992-7802).
  const logoStyle = list.provider === 'ebay' ? styles.logoEbay : styles.logoTcg;

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.header}>
        <Text style={theme.typography.titleMedium}>Price Trend</Text>
        <Image
          accessibilityLabel={providerLabel}
          resizeMode="contain"
          source={logoSource}
          style={logoStyle}
        />
      </View>

      {/* Full-bleed hairline under the title, then one under every row (Figma
          992-7381): each rule spans edge-to-edge and never doubles up where two
          rows meet. */}
      <View style={[styles.divider, { backgroundColor: theme.colors.outlineSubtle }]} />

      {list.rows.map((row) => (
        <Fragment key={row.key}>
          <View
            style={styles.row}
            testID={testID ? `${testID}-row-${row.key}` : undefined}
          >
            <Text style={[theme.typography.bodyMedium, styles.label]} numberOfLines={1}>
              {row.label}
            </Text>
            <PriceSparkline
              height={SPARKLINE_HEIGHT}
              points={row.points}
              testID={testID ? `${testID}-spark-${row.key}` : undefined}
              trendPct={row.trendPct}
              width={SPARKLINE_WIDTH}
            />
            <Text
              style={[theme.typography.titleSmall, styles.price]}
              testID={testID ? `${testID}-price-${row.key}` : undefined}
            >
              {row.currentPrice == null
                ? '—'
                : formatCurrency(row.currentPrice, row.currencyCode)}
            </Text>
          </View>
          <View style={[styles.divider, { backgroundColor: theme.colors.outlineSubtle }]} />
        </Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    // Break out of the screen's 16px content padding so the rule spans the full
    // device width (Figma 992-7381 row frame is 393px / edge-to-edge).
    height: StyleSheet.hairlineWidth,
    marginHorizontal: -16,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  label: {
    flex: 1,
  },
  logoEbay: {
    height: 20,
    width: 50,
  },
  logoTcg: {
    height: 20,
    width: 27,
  },
  price: {
    minWidth: 72,
    textAlign: 'right',
  },
  root: {
    width: '100%',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
});

export default CardPriceTrendList;

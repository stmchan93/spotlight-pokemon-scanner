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
      ? require('../../../../assets/images/ebay-icon.png')
      : require('../../../../assets/images/tcgplayer-icon.png');
  const providerLabel = list.provider === 'ebay' ? 'eBay' : 'TCGplayer';
  // Figma logo dimensions differ by provider: eBay 40×16, TCGplayer 21×16.
  const logoStyle = list.provider === 'ebay' ? styles.logoEbay : styles.logoTcg;

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.header}>
        <Text style={theme.typography.titleSmall}>Price Trend</Text>
        <Image
          accessibilityLabel={providerLabel}
          resizeMode="contain"
          source={logoSource}
          style={logoStyle}
        />
      </View>

      <View>
        {list.rows.map((row, index) => (
          <Fragment key={row.key}>
            {index > 0 ? (
              <View style={[styles.divider, { backgroundColor: theme.colors.outlineSubtle }]} />
            ) : null}
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
          </Fragment>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
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
    height: 16,
    width: 40,
  },
  logoTcg: {
    height: 16,
    width: 21,
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

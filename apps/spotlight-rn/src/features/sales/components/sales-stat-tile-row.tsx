import { StyleSheet, Text, View } from 'react-native';

import { colors, fontFamilies, textStyles } from '@spotlight/design-system';

type StatTile = {
  label: string;
  value: string;
};

type SalesStatTileRowProps = {
  totalSales: string;
  totalValue: string;
  totalProfit: string;
  testID?: string;
};

export function SalesStatTileRow({
  totalSales,
  totalValue,
  totalProfit,
  testID = 'sales-stat-tile-row',
}: SalesStatTileRowProps) {
  const tiles: StatTile[] = [
    { label: 'Total Sales', value: totalSales },
    { label: 'Total Value', value: totalValue },
    { label: 'Total Profit', value: totalProfit },
  ];

  return (
    <View style={styles.row} testID={testID}>
      {tiles.map((tile, idx) => (
        <View
          key={tile.label}
          style={[styles.tile, idx === 0 ? styles.tileFirst : null]}
          testID={`${testID}-${tile.label.toLowerCase().replace(/\s+/g, '-')}`}
        >
          <Text style={styles.label}>{tile.label}</Text>
          <Text style={styles.value}>{tile.value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
  tile: {
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: colors.gray200,
    borderRightWidth: 1,
    borderTopWidth: 1,
    flex: 1,
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  tileFirst: {
    borderLeftWidth: 1,
  },
  label: {
    ...textStyles.overline,
    color: colors.gray600,
    textAlign: 'center',
  },
  value: {
    color: colors.gray900,
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 15,
    lineHeight: 22.5,
    textAlign: 'center',
  },
});

import { StyleSheet, Text, View } from 'react-native';

import { colors, fontFamilies, textStyles } from '@spotlight/design-system';

type StatTile = {
  key: string;
  label: string;
  value: string;
};

type SalesStatTileRowProps = {
  /** Total monetary value of all transactions, preformatted (e.g. "$2,450"). */
  totalValue: string;
  /** Count of transactions, preformatted (e.g. "45"). */
  totalCount: string;
  testID?: string;
};

// Two summary cards per Figma 332:8609 — value + count. Each card has a top and
// bottom rule; the left card carries the single middle divider (border-right).
// No outer left/right border, so the row sits flush to the screen edges.
export function SalesStatTileRow({
  totalValue,
  totalCount,
  testID = 'sales-stat-tile-row',
}: SalesStatTileRowProps) {
  const tiles: StatTile[] = [
    { key: 'value', label: 'Total Transaction Value', value: totalValue },
    { key: 'count', label: 'Total # Transactions', value: totalCount },
  ];

  return (
    <View style={styles.row} testID={testID}>
      {tiles.map((tile, idx) => (
        <View
          key={tile.key}
          style={[styles.tile, idx < tiles.length - 1 ? styles.tileDivider : null]}
          testID={`${testID}-${tile.key}`}
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
    borderTopWidth: 1,
    flex: 1,
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  tileDivider: {
    borderRightWidth: 1,
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

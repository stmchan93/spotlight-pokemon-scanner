import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';
import type { PortfolioPerformanceRow } from '@spotlight/api-client';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { PriceSparkline } from '@/features/cards/components/price-sparkline';
import { formatCompactCurrency } from '@/features/portfolio/components/portfolio-formatting';

// Frozen-first-column table (Figma 2206-20251): the card identity column stays
// fixed on the left while the metric columns scroll horizontally. Both columns
// share the parent's vertical scroll (they're laid out side-by-side), so a
// vertical scroll moves them together and only the metrics pan sideways.
const CARD_COL_WIDTH = 132;
const ROW_HEIGHT = 44;
const ROW_GAP = 24;
const CELL_GAP = 16;
const CHART_W = 62;
const CELL_W = 60;
const HEADER_H = 36; // must match on both columns so rows line up

const METRIC_COLUMNS = [
  'Chart',
  'Current',
  '$ Tdy G/L',
  '% Tdy G/L',
  '$ Total',
  '% Total',
  'Cost',
] as const;

// "% Total" = all-time growth vs what the user paid. Null when either side is
// missing (no cost basis entered / no resolvable price).
export function allTimeGrowthPercent(row: PortfolioPerformanceRow): number | null {
  if (row.currentValue == null || row.costBasisTotal == null || row.costBasisTotal <= 0) {
    return null;
  }
  return ((row.currentValue - row.costBasisTotal) / row.costBasisTotal) * 100;
}

type PerformanceTableProps = {
  rows: PortfolioPerformanceRow[];
  currencyCode: string;
  testID?: string;
};

export function PerformanceTable({
  rows,
  currencyCode,
  testID = 'performance-table',
}: PerformanceTableProps) {
  const theme = useSpotlightTheme();

  const money = (value: number | null) =>
    value == null ? '—' : formatCompactCurrency(value, currencyCode);
  const percent = (value: number | null) =>
    value == null ? '—' : `${Math.round(value)}%`;
  const gainColor = (value: number | null) =>
    value == null
      ? theme.colors.gray900
      : value >= 0
        ? theme.colors.deltaUpText
        : theme.colors.deltaDownText;

  return (
    <View style={styles.table} testID={testID}>
      {/* Fixed card-identity column */}
      <View style={{ width: CARD_COL_WIDTH }}>
        <View style={styles.headerSlot} />
        <View style={styles.rowStack}>
          {rows.map((row) => (
            <View key={row.entryId} style={styles.cardCell} testID={`${testID}-card-${row.entryId}`}>
              {row.imageUrl ? (
                <CachedImage
                  cachePolicy={imageCachePolicy.thumbnail}
                  contentFit="cover"
                  style={styles.thumb}
                  uri={row.imageUrl}
                />
              ) : (
                <View style={[styles.thumb, { backgroundColor: theme.colors.gray100 }]} />
              )}
              <View style={styles.cardText}>
                <Text
                  numberOfLines={1}
                  style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}
                >
                  {row.name}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[theme.typography.label, { color: theme.colors.gray500 }]}
                >
                  {row.cardNumber}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      {/* Horizontally-scrollable metric columns */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.metricsContent}
        testID={`${testID}-metrics`}
      >
        <View>
          <View style={styles.headerRow}>
            {METRIC_COLUMNS.map((label) => (
              <Text
                key={label}
                numberOfLines={1}
                style={[
                  theme.typography.captionMedium,
                  { color: theme.colors.gray900, width: label === 'Chart' ? CHART_W : CELL_W },
                ]}
              >
                {label}
              </Text>
            ))}
          </View>
          <View style={styles.rowStack}>
            {rows.map((row) => (
              <View key={row.entryId} style={styles.metricRow}>
                <View style={styles.chartCell}>
                  {row.sparkline.length > 1 ? (
                    <PriceSparkline points={row.sparkline} trendPct={row.ytdGainPercent} />
                  ) : (
                    <Text style={[theme.typography.body, { color: theme.colors.gray400 }]}>—</Text>
                  )}
                </View>
                <Text style={[theme.typography.body, styles.cell, { color: theme.colors.gray900 }]}>
                  {money(row.currentPrice)}
                </Text>
                <Text style={[theme.typography.body, styles.cell, { color: gainColor(row.todayGainDollar) }]}>
                  {money(row.todayGainDollar)}
                </Text>
                <Text style={[theme.typography.body, styles.cell, { color: gainColor(row.todayGainPercent) }]}>
                  {percent(row.todayGainPercent)}
                </Text>
                <Text style={[theme.typography.body, styles.cell, { color: theme.colors.gray900 }]}>
                  {money(row.currentValue)}
                </Text>
                <Text style={[theme.typography.body, styles.cell, { color: gainColor(allTimeGrowthPercent(row)) }]}>
                  {percent(allTimeGrowthPercent(row))}
                </Text>
                <Text style={[theme.typography.body, styles.cell, { color: theme.colors.gray900 }]}>
                  {money(row.costBasisTotal)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  table: {
    flexDirection: 'row',
  },
  headerSlot: {
    height: HEADER_H,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: CELL_GAP,
    height: HEADER_H,
  },
  rowStack: {
    gap: ROW_GAP,
  },
  cardCell: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    height: ROW_HEIGHT,
  },
  thumb: {
    borderRadius: 2,
    height: 44,
    width: 32,
  },
  cardText: {
    flex: 1,
  },
  metricsContent: {
    paddingRight: 16,
  },
  metricRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: CELL_GAP,
    height: ROW_HEIGHT,
  },
  chartCell: {
    justifyContent: 'center',
    width: CHART_W,
  },
  cell: {
    width: CELL_W,
  },
});

export default PerformanceTable;

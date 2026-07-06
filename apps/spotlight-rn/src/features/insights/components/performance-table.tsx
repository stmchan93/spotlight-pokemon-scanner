import { forwardRef, useCallback } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItemInfo, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';
import { deckConditionOptions, type PortfolioPerformanceRow } from '@spotlight/api-client';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { getCardImageUrl } from '@/lib/card-images';
import { PriceSparkline } from '@/features/cards/components/price-sparkline';
import { formatCompactCurrency, formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

// Virtualized performance table (Figma 2206-20251, header row 2179-9032). A
// vertical FlatList of full-width rows ([card cell | metric cells]) sits inside
// ONE horizontal ScrollView so the metric columns pan sideways together and the
// whole grid stays aligned. The column-header row — the dark PORTFOLIO tag in
// the card-column slot plus the metric labels — is pinned above the list
// (inside the same horizontal ScrollView) so it stays visible while rows scroll
// vertically.
//
// Tradeoff vs. the old layout: the card-identity column is NOT frozen — it pans
// horizontally with the metrics. This keeps virtualization robust (one list, one
// getItemLayout, no two-list scroll-sync) and the card column is wide enough that
// little horizontal panning is needed to read it.
// Wide enough that the text block (192 − thumb − gap = 132pt) fits the longest
// common lines ("Reverse Holofoil", "Near Mint · ×3") without truncating.
const CARD_COL_WIDTH = 192;
const ROW_HEIGHT = 100; // taller rows: subtitle line + ~5 rows per iPhone screen
const CELL_GAP = 16;
// The card column sits 24px from the first metric column (Figma 2179-8996 vs
// 2179-9032); metric↔metric gaps stay CELL_GAP. Rows already flow with
// `gap: CELL_GAP`, so the card cell carries the extra 8px as margin.
const CARD_METRIC_EXTRA_GAP = 24 - CELL_GAP;
const HEADER_BOTTOM_GAP = 24;
const CHART_W = 62;
const CELL_W = 60;
const THUMB_W = 52;
const THUMB_H = 73; // keeps the 44x62 card aspect (~1.4)

// Figma 2179-9144 labels the G/L pair "Tdy", but the backend tracks month-over-
// month G/L — keep the Mth wording, adopt the design's title casing.
const METRIC_COLUMNS = [
  'Chart',
  'Current',
  '$ Mth G/L',
  '% Mth G/L',
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

// "$ Total" = all-time DOLLAR gain vs cost (current value − cost). Pairs with
// "% Total"; null on the same missing-inputs conditions. (The cell used to show
// currentValue, which read as a confusing duplicate of the "Current" column.)
export function allTimeGainDollar(row: PortfolioPerformanceRow): number | null {
  if (row.currentValue == null || row.costBasisTotal == null || row.costBasisTotal <= 0) {
    return null;
  }
  return row.currentValue - row.costBasisTotal;
}

// The backend emits `condition` as a deck-condition token (e.g. "near_mint"),
// not a human label — map it to the shared label ("Near Mint"), falling back to
// a Title-Cased version of the token if it's unrecognized.
function humanizeCondition(condition: string): string {
  const label = deckConditionOptions.find((option) => option.code === condition)?.label;
  if (label) {
    return label;
  }
  return condition
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Subtitle under the card name, on TWO lines: the printing/variant on its own
// line, then the "type" (grade for graded / condition for raw) with the quantity.
// (They used to be crammed onto one ` · `-joined line.) When there's no variant
// the type falls up to the first line so we never render a blank line.
function rowSubtitleLines(row: PortfolioPerformanceRow): {
  primary: string | null;
  secondary: string | null;
} {
  const quantity = row.quantity > 1 ? `×${row.quantity}` : null;
  const typeLabel =
    row.kind === 'graded'
      ? row.grade || null
      : row.condition
        ? humanizeCondition(row.condition)
        : null;
  const variant = row.variantName || null;
  const typeWithQuantity = [typeLabel, quantity].filter(Boolean).join(' · ') || null;
  if (!variant) {
    return { primary: typeWithQuantity, secondary: null };
  }
  return { primary: variant, secondary: typeWithQuantity };
}

// Dark "PORTFOLIO" tag (Figma 2179-8997). Lives in the pinned header row's
// card-column slot so it left-aligns with the card column and shares a baseline
// with the metric labels; also reused by the screen's empty state.
export function PortfolioTag() {
  const theme = useSpotlightTheme();
  return (
    <View style={[styles.portfolioTag, { backgroundColor: theme.colors.gray900 }]}>
      <Text style={[theme.typography.captionMedium, { color: theme.colors.gray0 }]}>
        PORTFOLIO
      </Text>
    </View>
  );
}

type PerformanceTableProps = {
  rows: PortfolioPerformanceRow[];
  currencyCode: string;
  onSelectRow?: (row: PortfolioPerformanceRow) => void;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLayout?: (event: Parameters<NonNullable<React.ComponentProps<typeof View>['onLayout']>>[0]) => void;
  refreshControl?: React.ComponentProps<typeof FlatList>['refreshControl'];
  contentInsetBottom?: number;
  testID?: string;
};

export const PerformanceTable = forwardRef<
  FlatList<PortfolioPerformanceRow>,
  PerformanceTableProps
>(function PerformanceTable(
  {
    rows,
    currencyCode,
    onSelectRow,
    onScroll,
    onLayout,
    refreshControl,
    contentInsetBottom = 0,
    testID = 'performance-table',
  },
  ref,
) {
  const theme = useSpotlightTheme();

  const money = useCallback(
    (value: number | null) => (value == null ? '—' : formatCompactCurrency(value, currencyCode)),
    [currencyCode],
  );
  // Signed money for GAIN/LOSS cells: formatCompactCurrency clamps anything ≤ 0
  // to "$0.00", so a real month/all-time LOSS (e.g. −$213) rendered as "$0.00"
  // while the % showed −5%. Show the true magnitude with a leading "−" for
  // losses; an exact zero stays "$0.00" (neutral/black via deltaColor).
  const gainMoney = useCallback(
    (value: number | null) => {
      if (value == null) {
        return '—';
      }
      if (Math.abs(value) < 0.005) {
        return formatCurrency(0, currencyCode);
      }
      const magnitude = formatCompactCurrency(Math.abs(value), currencyCode);
      return value < 0 ? `-${magnitude}` : magnitude;
    },
    [currencyCode],
  );
  const percent = useCallback(
    (value: number | null) => (value == null ? '—' : `${Math.round(value)}%`),
    [],
  );

  // Color by the DISPLAYED value: a cell that renders "0%" reads neutral
  // (gray900) instead of green/red so it's never misleadingly tinted. Percent
  // cells display whole percents (percent()), so zero = rounds to 0.
  const deltaColor = useCallback(
    (value: number | null) => {
      if (value == null || Math.round(value) === 0) {
        return theme.colors.gray900;
      }
      return value > 0 ? theme.colors.deltaUpText : theme.colors.deltaDownText;
    },
    [theme.colors.deltaDownText, theme.colors.deltaUpText, theme.colors.gray900],
  );
  // Dollar G/L cells display CENTS (gainMoney's 0.005 threshold), so they color
  // on the same threshold — a "−$0.30" month loss must read red even though it
  // rounds to $0. (Rounding-based neutral left small losses black.)
  const dollarDeltaColor = useCallback(
    (value: number | null) => {
      if (value == null || Math.abs(value) < 0.005) {
        return theme.colors.gray900;
      }
      return value > 0 ? theme.colors.deltaUpText : theme.colors.deltaDownText;
    },
    [theme.colors.deltaDownText, theme.colors.deltaUpText, theme.colors.gray900],
  );

  const renderItem = useCallback(
    ({ item: row }: ListRenderItemInfo<PortfolioPerformanceRow>) => {
      const subtitleLines = rowSubtitleLines(row);
      const totalPercent = allTimeGrowthPercent(row);
      const totalDollar = allTimeGainDollar(row);
      return (
        <View style={styles.dataRow}>
          <Pressable
            accessibilityLabel={`View ${row.name}`}
            accessibilityRole="button"
            onPress={() => onSelectRow?.(row)}
            style={[styles.cardCell, { width: CARD_COL_WIDTH }]}
            testID={`${testID}-card-${row.entryId}`}
          >
            {/* Small-variant first (getCardImageUrl 'small'), same as the
                Collection tiles/rows — the full-size scan in row.imageUrl is
                heavy enough that thumbs sat blank while it downloaded; the
                small URL paints fast and shares the app-wide image cache. */}
            {getCardImageUrl(row, 'small') ? (
              <CachedImage
                cachePolicy={imageCachePolicy.thumbnail}
                contentFit="cover"
                style={styles.thumb}
                uri={getCardImageUrl(row, 'small')}
              />
            ) : (
              <View style={[styles.thumb, { backgroundColor: theme.colors.gray100 }]} />
            )}
            <View style={styles.cardText}>
              <Text
                numberOfLines={2}
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
              {subtitleLines.primary ? (
                <Text
                  numberOfLines={1}
                  style={[theme.typography.label, { color: theme.colors.gray500 }]}
                  testID={`${testID}-subtitle-${row.entryId}`}
                >
                  {subtitleLines.primary}
                </Text>
              ) : null}
              {subtitleLines.secondary ? (
                <Text
                  numberOfLines={1}
                  style={[theme.typography.label, { color: theme.colors.gray500 }]}
                  testID={`${testID}-subtitle2-${row.entryId}`}
                >
                  {subtitleLines.secondary}
                </Text>
              ) : null}
            </View>
          </Pressable>

          <View style={styles.chartCell}>
            {row.sparkline.length > 1 ? (
              <PriceSparkline points={row.sparkline} trendPct={row.ytdGainPercent} />
            ) : (
              <Text style={[theme.typography.body, { color: theme.colors.gray400 }]}>—</Text>
            )}
          </View>
          {/* Current = unit price × quantity (backend `currentValue`), not the
              per-unit price — a 3× Near Mint entry shows the position's worth.
              The $ G/L column is likewise quantity-scaled backend-side. */}
          <Text style={[theme.typography.body, styles.cell, { color: theme.colors.gray900 }]}>
            {money(row.currentValue)}
          </Text>
          <Text style={[theme.typography.body, styles.cell, { color: dollarDeltaColor(row.monthGainDollar) }]}>
            {gainMoney(row.monthGainDollar)}
          </Text>
          <Text style={[theme.typography.body, styles.cell, { color: deltaColor(row.monthGainPercent) }]}>
            {percent(row.monthGainPercent)}
          </Text>
          <Text style={[theme.typography.body, styles.cell, { color: dollarDeltaColor(totalDollar) }]}>
            {gainMoney(totalDollar)}
          </Text>
          <Text style={[theme.typography.body, styles.cell, { color: deltaColor(totalPercent) }]}>
            {percent(totalPercent)}
          </Text>
          <Text style={[theme.typography.body, styles.cell, { color: theme.colors.gray900 }]}>
            {money(row.costBasisTotal)}
          </Text>
        </View>
      );
    },
    [
      deltaColor,
      dollarDeltaColor,
      gainMoney,
      money,
      onSelectRow,
      percent,
      testID,
      theme.colors.gray100,
      theme.colors.gray400,
      theme.colors.gray500,
      theme.colors.gray900,
      theme.typography.body,
      theme.typography.bodyMedium,
      theme.typography.label,
    ],
  );

  const keyExtractor = useCallback((row: PortfolioPerformanceRow) => row.entryId, []);

  const getItemLayout = useCallback(
    (_data: ArrayLike<PortfolioPerformanceRow> | null | undefined, index: number) => ({
      length: ROW_HEIGHT,
      offset: ROW_HEIGHT * index,
      index,
    }),
    [],
  );

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.hScroll}
      contentContainerStyle={styles.hScrollContent}
      // Let vertical drags reach the inner FlatList; only pan horizontally.
      directionalLockEnabled
      testID={`${testID}-metrics`}
    >
      <View style={styles.grid}>
        {/* Pinned column header: stays visible above the rows as they scroll. */}
        <View style={[styles.headerRow, { backgroundColor: theme.colors.gray0 }]}>
          <View style={[styles.cardHeaderSlot, { width: CARD_COL_WIDTH }]}>
            <PortfolioTag />
          </View>
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
        <FlatList
          ref={ref}
          data={rows}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          getItemLayout={getItemLayout}
          initialNumToRender={8}
          maxToRenderPerBatch={8}
          windowSize={7}
          removeClippedSubviews
          nestedScrollEnabled
          onScroll={onScroll}
          onLayout={onLayout}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          refreshControl={refreshControl}
          style={styles.list}
          contentContainerStyle={{ paddingBottom: contentInsetBottom }}
          testID={testID}
        />
      </View>
    </ScrollView>
  );
});

// Loading placeholder shown while the performance query is in flight — mirrors
// the header + row layout so the table "materializes" rather than flashing an
// empty "no cards" state. Static gray blocks (matches SalesHistorySkeleton).
export function PerformanceTableSkeleton({ testID = 'performance-table-skeleton' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const fill = { backgroundColor: theme.colors.outlineSubtle };
  return (
    <View style={styles.grid} testID={testID}>
      <View style={styles.headerRow}>
        <View style={[styles.cardHeaderSlot, { width: CARD_COL_WIDTH }]}>
          <PortfolioTag />
        </View>
      </View>
      {Array.from({ length: 6 }).map((_, index) => (
        <View key={index} style={styles.dataRow}>
          <View style={[styles.cardCell, { width: CARD_COL_WIDTH }]}>
            <View style={[styles.thumb, fill]} />
            <View style={styles.cardText}>
              <View style={[styles.skeletonLine, { width: '92%' }, fill]} />
              <View style={[styles.skeletonLine, { width: '55%' }, fill]} />
              <View style={[styles.skeletonLine, { width: '72%' }, fill]} />
            </View>
          </View>
          <View style={[styles.skeletonCell, fill]} />
          <View style={[styles.skeletonCell, fill]} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  hScroll: {
    flex: 1,
  },
  hScrollContent: {
    // Fill the ScrollView height so the inner FlatList has a bounded viewport to
    // virtualize against (cross-axis stretch of a horizontal ScrollView).
    flexGrow: 1,
    paddingRight: 16,
  },
  grid: {
    alignSelf: 'stretch',
  },
  list: {
    flex: 1,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: CELL_GAP,
    // 24px between the header row and the first data row (Figma 2179-9032).
    marginBottom: HEADER_BOTTOM_GAP,
  },
  cardHeaderSlot: {
    justifyContent: 'center',
    marginRight: CARD_METRIC_EXTRA_GAP,
  },
  portfolioTag: {
    // Spans the full card column (Figma 2179-8997 fills its column) so the
    // Chart header sits exactly 24px to the tag's right, not 24px past the
    // (much wider) column edge.
    alignItems: 'center',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    width: CARD_COL_WIDTH,
  },
  dataRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: CELL_GAP,
    height: ROW_HEIGHT,
  },
  cardCell: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginRight: CARD_METRIC_EXTRA_GAP,
  },
  thumb: {
    borderRadius: 2,
    height: THUMB_H,
    width: THUMB_W,
  },
  cardText: {
    flex: 1,
    gap: 2,
  },
  chartCell: {
    justifyContent: 'center',
    width: CHART_W,
  },
  cell: {
    width: CELL_W,
  },
  skeletonLine: {
    borderRadius: 4,
    height: 12,
  },
  skeletonCell: {
    borderRadius: 4,
    height: 14,
    width: CELL_W,
  },
});

export default PerformanceTable;

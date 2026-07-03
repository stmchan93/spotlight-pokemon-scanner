import { forwardRef, useCallback } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ListRenderItemInfo, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { useSpotlightTheme } from '@spotlight/design-system';
import { deckConditionOptions, type PortfolioPerformanceRow } from '@spotlight/api-client';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { PriceSparkline } from '@/features/cards/components/price-sparkline';
import { formatCompactCurrency } from '@/features/portfolio/components/portfolio-formatting';

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
const CARD_COL_WIDTH = 168;
const ROW_HEIGHT = 100; // taller rows: subtitle line + ~5 rows per iPhone screen
const CELL_GAP = 16;
// The card column sits 24px from the first metric column (Figma 2179-8996 vs
// 2179-9032); metric↔metric gaps stay CELL_GAP. Rows already flow with
// `gap: CELL_GAP`, so the card cell carries the extra 8px as margin.
const CARD_METRIC_EXTRA_GAP = 24 - CELL_GAP;
const HEADER_BOTTOM_GAP = 24;
const CHART_W = 62;
const CELL_W = 60;
const THUMB_W = 44;
const THUMB_H = 62;

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

// Compact subtitle under the card name: variant/condition (raw) or grade
// (graded), plus quantity when the user owns more than one copy.
function rowSubtitle(row: PortfolioPerformanceRow): string | null {
  const parts: string[] = [];
  if (row.kind === 'graded') {
    if (row.grade) {
      parts.push(row.grade);
    }
  } else {
    if (row.variantName) {
      parts.push(row.variantName);
    }
    if (row.condition) {
      parts.push(humanizeCondition(row.condition));
    }
  }
  if (row.quantity > 1) {
    parts.push(`×${row.quantity}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
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
  const percent = useCallback(
    (value: number | null) => (value == null ? '—' : `${Math.round(value)}%`),
    [],
  );

  // Color by the DISPLAYED value: a gain that rounds to $0 / 0% reads neutral
  // (gray900) instead of green/red so a "$0" cell is never misleadingly tinted.
  const deltaColor = useCallback(
    (value: number | null) => {
      if (value == null || Math.round(value) === 0) {
        return theme.colors.gray900;
      }
      return value > 0 ? theme.colors.deltaUpText : theme.colors.deltaDownText;
    },
    [theme.colors.deltaDownText, theme.colors.deltaUpText, theme.colors.gray900],
  );

  const renderItem = useCallback(
    ({ item: row }: ListRenderItemInfo<PortfolioPerformanceRow>) => {
      const subtitle = rowSubtitle(row);
      const totalPercent = allTimeGrowthPercent(row);
      return (
        <View style={styles.dataRow}>
          <Pressable
            accessibilityLabel={`View ${row.name}`}
            accessibilityRole="button"
            onPress={() => onSelectRow?.(row)}
            style={[styles.cardCell, { width: CARD_COL_WIDTH }]}
            testID={`${testID}-card-${row.entryId}`}
          >
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
              {subtitle ? (
                <Text
                  numberOfLines={1}
                  style={[theme.typography.label, { color: theme.colors.gray500 }]}
                  testID={`${testID}-subtitle-${row.entryId}`}
                >
                  {subtitle}
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
          <Text style={[theme.typography.body, styles.cell, { color: deltaColor(row.monthGainDollar) }]}>
            {money(row.monthGainDollar)}
          </Text>
          <Text style={[theme.typography.body, styles.cell, { color: deltaColor(row.monthGainPercent) }]}>
            {percent(row.monthGainPercent)}
          </Text>
          <Text style={[theme.typography.body, styles.cell, { color: theme.colors.gray900 }]}>
            {money(row.currentValue)}
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
    alignSelf: 'flex-start',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
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
});

export default PerformanceTable;

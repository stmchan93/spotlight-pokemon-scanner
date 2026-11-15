import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { NavArrowDown } from 'iconoir-react-native';

import type {
  CardPriceTrendMode,
  CardPriceTrendRow,
  CardRecentSalesRecord,
  SpotlightRepository,
} from '@spotlight/api-client';
import {
  RollingNumber,
  SkeletonBlock,
  Text,
  TrendTriangle,
  borderWidths,
  layout,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import {
  GradeConditionSheet,
  type GradeConditionOption,
} from '@/features/cards/components/grade-condition-sheet';
import { PriceScrubChart } from '@/features/cards/components/price-scrub-chart';
import {
  defaultPriceChartRange,
  priceChartRanges,
  priceChartReadout,
  resolveDefaultRowKey,
  type ChartTone,
  type PriceChartRange,
} from '@/features/cards/card-price-chart-model';
import { useCardPriceChart } from '@/features/cards/hooks/use-card-price-chart';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

export const PRICE_CHART_HEIGHT = 210;

type CardPriceChartSectionProps = {
  repository: SpotlightRepository;
  cardId: string;
  /** False until the page's detail (hence its printing) has loaded. */
  enabled: boolean;
  mode: CardPriceTrendMode;
  /** The lane's Price Trend rows (conditions or grades) — the chip's options. */
  rows: readonly CardPriceTrendRow[];
  /** The lane's rows are still loading. */
  rowsLoading: boolean;
  variantLabel: string | null;
  /** Seeds the chip: the owned/seeded condition (raw) or grade (graded). */
  preferredCondition: string | null;
  preferredGrade: string | null;
  salesEnabled: boolean;
  /** Comps the page already holds per row key (expanded graded rows). */
  salesByRowKey?: Readonly<Record<string, CardRecentSalesRecord | null>>;
  /** Horizontal padding of the host surface; the chart bleeds back out by it. */
  gutter?: number;
  /** Host surface style (e.g. the PDP's inset chart card); skipped when hidden. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Robinhood-style price block for the PDP: big price, delta line, row chip,
 * scrubbable chart, range buttons, and an "as of" line.
 */
export function CardPriceChartSection({
  repository,
  cardId,
  enabled,
  mode,
  rows,
  rowsLoading,
  variantLabel,
  preferredCondition,
  preferredGrade,
  salesEnabled,
  salesByRowKey,
  gutter = layout.pageGutter,
  style,
  testID = 'card-price-chart',
}: CardPriceChartSectionProps) {
  const theme = useSpotlightTheme();
  const [pickedRowKey, setPickedRowKey] = useState<string | null>(null);
  const [range, setRange] = useState<PriceChartRange>(defaultPriceChartRange);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // A new card or lane starts from its own default row.
  useEffect(() => {
    setPickedRowKey(null);
    setScrubIndex(null);
  }, [cardId, mode]);

  const rowKey = useMemo(() => {
    if (pickedRowKey && rows.some((row) => row.key === pickedRowKey)) {
      return pickedRowKey;
    }
    return resolveDefaultRowKey(rows, mode, { condition: preferredCondition, grade: preferredGrade });
  }, [mode, pickedRowKey, preferredCondition, preferredGrade, rows]);
  const selectedRow = rows.find((row) => row.key === rowKey) ?? null;

  const chart = useCardPriceChart({
    repository,
    cardId,
    enabled: enabled && !rowsLoading,
    mode,
    rowKey,
    variantLabel,
    range,
    salesEnabled,
    seededSales: rowKey ? salesByRowKey?.[rowKey] : null,
  });

  const toneColor = useCallback((tone: ChartTone) => (
    tone === 'up' ? theme.colors.green400 : tone === 'down' ? theme.colors.red400 : theme.colors.gray600
  ), [theme.colors]);

  const sheetOptions = useMemo<GradeConditionOption[]>(() => rows.map((row) => ({
    id: row.key,
    label: row.label,
    detail: row.currentPrice != null ? formatCurrency(row.currentPrice, row.currencyCode) : null,
  })), [rows]);

  const handleSelectRow = useCallback((key: string) => {
    setPickedRowKey(key);
    setScrubIndex(null);
  }, []);
  const handleSelectRange = useCallback((next: PriceChartRange) => {
    setRange(next);
    setScrubIndex(null);
  }, []);

  if (chart.status === 'hidden') {
    return null;
  }
  if (chart.status === 'loading' || !selectedRow) {
    return <CardPriceChartSkeleton style={style} testID={`${testID}-skeleton`} />;
  }

  const { model } = chart;
  const readout = priceChartReadout(model, scrubIndex);
  const deltaColor = readout.delta
    ? toneColor(readout.delta.direction === 'flat' ? 'neutral' : readout.delta.direction)
    : theme.colors.gray600;
  const priceLabel = formatCurrency(readout.value, model.currencyCode);

  return (
    <View style={[styles.root, style]} testID={testID}>
      <View style={styles.header}>
        <RollingNumber
          accessibilityLabel={priceLabel}
          animate={scrubIndex == null}
          style={[theme.typography.detailTitleBold, { color: theme.colors.gray900 }]}
          testID={`${testID}-price`}
          value={priceLabel}
        />
        <View style={styles.deltaRow} testID={`${testID}-delta`}>
          {readout.delta && readout.delta.direction !== 'flat' ? (
            <TrendTriangle color={deltaColor} direction={readout.delta.direction} />
          ) : null}
          {readout.delta ? (
            <Text style={[theme.typography.titleXsmall, { color: deltaColor }]} testID={`${testID}-delta-amount`}>
              {readout.delta.label}
            </Text>
          ) : null}
          {/* At rest the line is just price + delta (Figma 6322:8976); the date
              caption appears only while scrubbing a point. */}
          {scrubIndex != null ? (
            <Text
              style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}
              testID={`${testID}-delta-suffix`}
            >
              {readout.suffix}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityHint="Choose which price to chart"
          accessibilityRole="button"
          onPress={() => setSheetOpen(true)}
          style={({ pressed }) => [
            styles.chip,
            { borderColor: theme.colors.gray300, backgroundColor: theme.colors.gray0, opacity: pressed ? 0.7 : 1 },
          ]}
          testID={`${testID}-chip`}
        >
          {/* Compact chip (Figma 6322:8987): Regular 10, small chevron. */}
          <Text style={[theme.typography.captionTiny, { color: theme.colors.gray900 }]}>{selectedRow.label}</Text>
          <NavArrowDown color={theme.colors.gray900} height={12} strokeWidth={2} width={12} />
        </Pressable>
      </View>

      <View style={{ marginHorizontal: -gutter }}>
        {model.insufficient ? (
          <View style={styles.emptyChart} testID={`${testID}-empty`}>
            <Text style={[theme.typography.body, styles.emptyCopy, { color: theme.colors.gray600 }]}>
              {model.emptyMessage}
            </Text>
          </View>
        ) : (
          <PriceScrubChart
            // Figma 6322:8991: brand purple line over a soft purple gradient,
            // whatever the trend direction (the delta line carries green/red).
            areaFill
            color={theme.colors.purple500}
            fillGrid={false}
            height={PRICE_CHART_HEIGHT}
            onScrub={setScrubIndex}
            points={model.points}
            testID={`${testID}-chart`}
            variant={model.variant}
            windowEndMs={model.windowEndMs}
            windowStartMs={model.windowStartMs}
          />
        )}
      </View>

      <View style={styles.rangeRow} testID={`${testID}-ranges`}>
        {priceChartRanges.map((option) => {
          const selected = option === range;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={option}
              onPress={() => handleSelectRange(option)}
              // Figma 6322:8994: neutral filter — gray/100 fill on the selected range.
              style={[styles.rangeButton, selected && { backgroundColor: theme.colors.gray100 }]}
              testID={`${testID}-range-${option}`}
            >
              <Text
                style={[
                  theme.typography.label,
                  { color: selected ? theme.colors.gray900 : theme.colors.gray700 },
                ]}
              >
                {option}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <GradeConditionSheet
        onClose={() => setSheetOpen(false)}
        onSelect={handleSelectRow}
        options={sheetOptions}
        selectedId={rowKey}
        testID={`${testID}-sheet`}
        title={mode === 'graded' ? 'Grade' : 'Condition'}
        visible={sheetOpen}
      />
    </View>
  );
}

/** Same footprint as the loaded section so nothing below jumps when it lands. */
function CardPriceChartSkeleton({ style, testID }: { style?: StyleProp<ViewStyle>; testID: string }) {
  return (
    <View style={[styles.root, style]} testID={testID}>
      <View style={styles.header}>
        <SkeletonBlock height={38} width={160} />
        <SkeletonBlock height={18} width={200} />
        <SkeletonBlock height={32} radius={radii.pill} width={120} />
      </View>
      <SkeletonBlock height={PRICE_CHART_HEIGHT} />
      <SkeletonBlock height={36} />
      <SkeletonBlock height={16} width={220} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.xxs,
    width: '100%',
  },
  header: {
    alignItems: 'flex-start',
    gap: spacing.xxxs,
  },
  deltaRow: {
    alignItems: 'center',
    columnGap: spacing.xxxs,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  chip: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    borderWidth: borderWidths.containerRule,
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingHorizontal: spacing.xxs,
    paddingVertical: 3,
  },
  emptyChart: {
    alignItems: 'center',
    height: PRICE_CHART_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxxl,
  },
  emptyCopy: {
    textAlign: 'center',
  },
  rangeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
  },
  rangeButton: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xxxs,
  },
});

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { NavArrowRight } from 'iconoir-react-native';

import type { AssistantChartRange, AssistantPriceChart } from '@spotlight/api-client';
import { radii, spacing, Text, TrendTriangle, useSpotlightTheme } from '@spotlight/design-system';

import {
  buildPriceChartModel,
  formatChartDate,
  parseCalendarDayMs,
  priceChartReadout,
  type ChartPoint,
  type PriceChartModel,
  type PriceChartRange,
} from '@/features/cards/card-price-chart-model';
import { PriceScrubChart } from '@/features/cards/components/price-scrub-chart';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

const COMPACT_CHART_HEIGHT = 120;
const DELTA_TRIANGLE_SIZE = 7;
const CHEVRON_SIZE = 16;

const rangeMap: Record<AssistantChartRange, PriceChartRange> = { '30d': '1M', '90d': '3M', '1y': '1Y' };
const rangeCaption: Record<AssistantChartRange, string> = {
  '30d': 'Past month',
  '90d': 'Past 3 months',
  '1y': 'Past year',
};

export function assistantRangeCaption(range: AssistantChartRange): string {
  return rangeCaption[range];
}

/** "NM · Past 3 months", "PSA 10 · Reverse Holofoil · Past year". */
export function assistantChartSeriesLabel(chart: AssistantPriceChart): string {
  const lane = chart.grader ? [chart.grader, chart.grade].filter(Boolean).join(' ') : chart.condition ?? 'NM';
  return [lane, chart.variant, rangeCaption[chart.range]].filter(Boolean).join(' · ');
}

/**
 * The PDP chart model over the chat's stored series. The window ends at the
 * series' newest point, not today: the chart is a snapshot of that answer, so
 * reopening an old thread must not turn it into "No recent prices".
 */
export function buildAssistantChartModel(chart: AssistantPriceChart): PriceChartModel | null {
  const points: ChartPoint[] = chart.points
    .map((point) => ({ t: parseCalendarDayMs(point.date), v: point.usd }))
    .filter((point): point is ChartPoint => point.t != null)
    .sort((a, b) => a.t - b.t);
  const latest = points[points.length - 1];
  if (!latest) {
    return null;
  }
  const model = buildPriceChartModel({
    allPoints: points,
    variant: 'line',
    range: rangeMap[chart.range],
    nowMs: latest.t,
    currencyCode: 'USD',
  });
  return model && !model.insufficient ? model : null;
}

type AssistantPriceChartCardProps = {
  chart: AssistantPriceChart;
  onOpenCard: (cardId: string) => void;
  testID?: string;
};

/** Compact PDP price chart inside a reply: price + delta, scrubbable line, as-of line. */
export function AssistantPriceChartCard({ chart, onOpenCard, testID }: AssistantPriceChartCardProps) {
  const theme = useSpotlightTheme();
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const model = useMemo(() => buildAssistantChartModel(chart), [chart]);
  if (!model) {
    return null;
  }
  const latestMs = model.points[model.points.length - 1]?.t ?? model.windowEndMs;
  const readout = priceChartReadout(model, scrubIndex, latestMs);
  const direction = readout.delta?.direction ?? 'flat';
  const deltaColor = direction === 'up'
    ? theme.colors.green400
    : direction === 'down'
      ? theme.colors.red400
      : theme.colors.gray600;
  const source = chart.source === 'tcgplayer' ? ' · TCGplayer market' : '';
  const asOf = `Prices as of ${formatChartDate(latestMs)}${source}`;

  return (
    <View
      style={[styles.card, { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray200 }]}
      testID={testID}
    >
      <Pressable
        accessibilityHint="Opens the card page"
        accessibilityLabel={`${chart.name}, ${assistantChartSeriesLabel(chart)}`}
        accessibilityRole="button"
        onPress={() => onOpenCard(chart.cardId)}
        style={({ pressed }) => [styles.header, { opacity: pressed ? 0.7 : 1 }]}
        testID={testID ? `${testID}-open` : undefined}
      >
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} style={theme.typography.labelStrong}>
            {chart.name}
          </Text>
          <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
            {assistantChartSeriesLabel(chart)}
          </Text>
        </View>
        <NavArrowRight color={theme.colors.gray600} height={CHEVRON_SIZE} width={CHEVRON_SIZE} />
      </Pressable>
      <View style={styles.readout}>
        <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]} testID={testID ? `${testID}-price` : undefined}>
          {formatCurrency(readout.value, 'USD')}
        </Text>
        {readout.delta ? (
          <View style={styles.delta} testID={testID ? `${testID}-delta` : undefined}>
            {direction !== 'flat' ? (
              <TrendTriangle color={deltaColor} direction={direction} size={DELTA_TRIANGLE_SIZE} />
            ) : null}
            <Text style={[theme.typography.captionMedium, { color: deltaColor }]}>{readout.delta.label}</Text>
          </View>
        ) : null}
        {scrubIndex != null ? (
          <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}>{readout.suffix}</Text>
        ) : null}
      </View>
      <PriceScrubChart
        areaFill
        color={theme.colors.purple500}
        fillGrid={false}
        height={COMPACT_CHART_HEIGHT}
        onScrub={setScrubIndex}
        points={model.points}
        testID={testID ? `${testID}-chart` : undefined}
        variant="line"
        windowEndMs={model.windowEndMs}
        windowStartMs={model.windowStartMs}
      />
      <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID={testID ? `${testID}-as-of` : undefined}>
        {asOf}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: 1,
    gap: spacing.xxs,
    overflow: 'hidden',
    padding: spacing.xs,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  headerCopy: {
    flex: 1,
  },
  readout: {
    alignItems: 'center',
    columnGap: spacing.xxs,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  delta: {
    alignItems: 'center',
    columnGap: 2,
    flexDirection: 'row',
  },
});

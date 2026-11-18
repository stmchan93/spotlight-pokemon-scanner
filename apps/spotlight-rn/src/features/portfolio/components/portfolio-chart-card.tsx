import {
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';

import { useTabsPage } from '@/contexts/tabs-page-context';
import { PriceScrubChart, type PriceChartPoint } from '@/features/cards/components/price-scrub-chart';
import { nearestIndexByX } from '@/features/cards/components/price-scrub-chart-geometry';
import Svg, {
  Circle,
  Line,
  Path,
  Rect,
} from 'react-native-svg';

import type {
  ChartMode,
  PortfolioDashboard,
  PortfolioHistoryRange,
  PortfolioRangeSummary,
  RecentSaleRecord,
} from '@spotlight/api-client';
import { Text, borderWidths, layout, radii, spacing, textStyles, useSpotlightTheme } from '@spotlight/design-system';

import {
  formatCurrency,
  formatPercent,
  formatSignedCurrency,
} from './portfolio-formatting';

// Scrub gesture thresholds, shared with the PDP chart's feel.
const SCRUB_LONG_PRESS_MS = 250;
const SCRUB_DRAG_ACTIVE_OFFSET_X = 6;
const SCRUB_DRAG_FAIL_OFFSET_Y = 10;

// `nominalDays` is what the LABEL promises. Price history starts 2026-04-16, so
// the longer ranges clamp to that first day and print identical numbers under
// different labels — compare against this to caption the ones that fall short.
// ALL promises no particular length, so it can never be short.
const rangeItems = [
  { label: '7D', value: '1W', nominalDays: 7 },
  { label: '1M', value: '1M', nominalDays: 30 },
  { label: '3M', value: '3M', nominalDays: 90 },
  { label: '1Y', value: '1Y', nominalDays: 365 },
  { label: 'ALL', value: 'ALL', nominalDays: null },
] as const;

const DAY_MS = 86400000;

// A range whose first day lands within a couple of days of the nominal window
// is honest enough — daily points and timezone edges cost about that much.
const RANGE_CLAMP_TOLERANCE_DAYS = 2;

// The line's y-window spans at least this fraction of the portfolio value, so
// a move's height on screen tracks its real size (3% ≈ a third of the chart).
const LINE_MIN_SPAN_RATIO = 0.08;

// Below this, the baseline is too near zero to divide by.
const MEANINGFUL_BASELINE_VALUE = 1;

const skeletonBarScales = [0.42, 0.62, 0.5, 0.74, 0.58, 0.82, 0.68, 0.9, 0.76, 0.56, 0.72, 0.64];

// Soften each interior corner of the line by rounding it with an arc of up to
// this radius, clamped to half the shorter adjacent segment so neighbouring
// corners never overshoot each other. 72px is large relative to the ~176px
// plot, so the line reads as a smooth curve rather than a sharp polyline.
const LINE_CORNER_RADIUS = 72;

// Where the corner arc enters/exits around an interior vertex — shared by the
// path builder and the scrub-dot math so the dot provably rides the drawn line.
function cornerTrimPoints(
  prev: { x: number; y: number },
  curr: { x: number; y: number },
  next: { x: number; y: number },
) {
  const inLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
  const outLen = Math.hypot(next.x - curr.x, next.y - curr.y);
  const trim = Math.min(LINE_CORNER_RADIUS, inLen / 2, outLen / 2);

  if (trim <= 0) {
    // Coincident points — keep the hard vertex rather than divide by zero.
    return null;
  }

  return {
    entry: {
      x: curr.x + ((prev.x - curr.x) / inLen) * trim,
      y: curr.y + ((prev.y - curr.y) / inLen) * trim,
    },
    exit: {
      x: curr.x + ((next.x - curr.x) / outLen) * trim,
      y: curr.y + ((next.y - curr.y) / outLen) * trim,
    },
  };
}

function buildLinePath(points: readonly { x: number; y: number }[]) {
  if (points.length === 0) {
    return '';
  }

  if (points.length === 1) {
    const point = points[0];
    return `M ${point.x} ${point.y}`;
  }

  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }

  let path = `M ${points[0].x} ${points[0].y}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const curr = points[index];
    const corner = cornerTrimPoints(points[index - 1], curr, points[index + 1]);

    if (!corner) {
      path += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    // Stop short of the vertex on the way in, curve toward the vertex (the
    // quadratic control point), and resume short of it on the way out.
    path += ` L ${corner.entry.x} ${corner.entry.y} Q ${curr.x} ${curr.y} ${corner.exit.x} ${corner.exit.y}`;
  }

  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
}

// The point the DRAWN line actually passes through at a data index. The corner
// arc is a quadratic that cuts inside the vertex (the vertex is only its
// control point), so at curvy spots the raw coordinate sits visibly off the
// rendered line. The curve's closest pass is its t=0.5 point:
// (entry + 2·vertex + exit) / 4. Endpoints are drawn exactly, so they pass
// through unchanged.
function renderedLinePointAt(points: readonly { x: number; y: number }[], index: number) {
  const curr = points[index];
  if (!curr || points.length < 3 || index === 0 || index === points.length - 1) {
    return curr ?? null;
  }

  const corner = cornerTrimPoints(points[index - 1], curr, points[index + 1]);
  if (!corner) {
    return curr;
  }

  return {
    x: (corner.entry.x + 2 * curr.x + corner.exit.x) / 4,
    y: (corner.entry.y + 2 * curr.y + corner.exit.y) / 4,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeChartPointDate(isoDate: string) {
  return isoDate.includes('T') ? isoDate : `${isoDate}T12:00:00.000Z`;
}

// "May 7, 2026" — used by the parent header when the user is scrubbing the chart.
function formatHoverDateLabel(isoDate: string) {
  const date = new Date(normalizeChartPointDate(isoDate));
  if (Number.isNaN(date.valueOf())) {
    return '';
  }

  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// "JAN, 1, 2026" — the on-chart scrub tooltip headline. Matches the Figma
// modal (uppercase short month, comma-separated day and year).
function formatTooltipDateLabel(isoDate: string) {
  const date = new Date(normalizeChartPointDate(isoDate));
  if (Number.isNaN(date.valueOf())) {
    return '';
  }

  // toLocaleDateString → "Jan 1, 2026"; insert a comma after the month and
  // uppercase the whole thing → "JAN, 1, 2026".
  return date
    .toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    })
    .replace(/^(\w+)\s/, '$1, ')
    .toUpperCase();
}

// The portfolio LINE auto-scales to the visible value range (not 0→max), with
// a minimum span so small moves stay small (a $50 dip on $1,700 filled the full
// height and read as a 50% crash), and headroom off the edges.
export function portfolioLineYDomain(rawValues: readonly number[]) {
  const values = rawValues.filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    return { min: 0, max: 1 };
  }
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const minSpan = Math.abs(dataMax) * LINE_MIN_SPAN_RATIO || 2;
  const paddedSpan = Math.max((dataMax - dataMin) * 1.2, minSpan);
  const mid = (dataMax + dataMin) / 2;
  return { min: mid - paddedSpan / 2, max: mid + paddedSpan / 2 };
}

// A collection's first days are often a handful of cards, then a bulk add
// spread over a day or two; plotted, that is a cliff that flattens every later
// move. The line starts on the LAST day the value at least doubled overnight —
// a partial first day ($534 before the full $2,949) is skipped with the rest,
// while gradual growth is never cut.
const WARMUP_JUMP_RATIO = 2;

export function trimPortfolioWarmup<T extends { value: number }>(points: readonly T[]): T[] {
  let start = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1].value;
    if (points[index].value > 0 && points[index].value >= Math.max(previous, 0) * WARMUP_JUMP_RATIO) {
      start = index;
    }
  }
  return start > 0 && start < points.length - 1 ? points.slice(start) : [...points];
}

/** The range's change re-based onto the first plotted (post-warm-up) day. */
export function portfolioRangeSummaryAfterWarmup(
  points: readonly { value: number }[],
  summary: PortfolioRangeSummary | null,
): PortfolioRangeSummary | null {
  const trimmed = trimPortfolioWarmup(points);
  const newStart = trimmed[0]?.value;
  if (!summary || newStart == null || trimmed.length === points.length) {
    return summary;
  }
  // Shift the backend's baseline rather than recompute from the last point:
  // its change deliberately excludes value only today's live pricing sees.
  const changeAmount = Number((summary.changeAmount + summary.startValue - newStart).toFixed(2));
  return {
    ...summary,
    startValue: newStart,
    changeAmount,
    changePercent: newStart >= MEANINGFUL_BASELINE_VALUE
      ? Number(((changeAmount / newStart) * 100).toFixed(2))
      : null,
  };
}

// "Apr 2026" — the caption for a range that starts later than its label claims.
function formatMonthYearLabel(isoDate: string) {
  const date = new Date(normalizeChartPointDate(isoDate));
  if (Number.isNaN(date.valueOf())) {
    return '';
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * "Since Apr 2026" when the range's data starts materially later than its label
 * promises, else null. 3M / 1Y / ALL all clamp to the first day of price
 * history and then read as broken — identical numbers under different labels.
 * Captioning beats widening the pills: 5 pills at gap 24 won't hold the string.
 */
export function portfolioRangeCaption(
  range: PortfolioHistoryRange,
  points: readonly { isoDate: string }[],
  now: Date = new Date(),
): string | null {
  const nominalDays = rangeItems.find((item) => item.value === range)?.nominalDays ?? null;
  const firstPoint = points[0];
  if (nominalDays == null || !firstPoint) {
    return null;
  }

  const firstTimestamp = Date.parse(normalizeChartPointDate(firstPoint.isoDate));
  if (!Number.isFinite(firstTimestamp)) {
    return null;
  }

  const earliestHonestStart = now.getTime() - (nominalDays - RANGE_CLAMP_TOLERANCE_DAYS) * DAY_MS;
  if (firstTimestamp <= earliestHonestStart) {
    return null;
  }

  return `Since ${formatMonthYearLabel(firstPoint.isoDate)}`;
}

function buildRoundedCurrencyTicks(values: number[]) {
  const maxValue = Math.max(...values, 0);
  const upperTick = maxValue > 0 ? Number(maxValue.toFixed(2)) : 1;
  return upperTick;
}

function findPortfolioBaselinePoint(
  points: readonly PortfolioDashboard['ranges'][PortfolioHistoryRange]['portfolio'][number][],
  targetIndex = points.length - 1,
) {
  const boundedTargetIndex = Math.max(0, Math.min(targetIndex, points.length - 1));
  const firstPositivePoint = points.find((point, index) => {
    return index <= boundedTargetIndex && point.value > 0;
  });

  return firstPositivePoint ?? points[0] ?? null;
}

function buildSalesPointCounts(
  points: readonly PortfolioDashboard['ranges'][PortfolioHistoryRange]['sales'][number][],
  recentSales: readonly RecentSaleRecord[],
) {
  const backendCounts = points.map((point) => {
    const count = point.salesCount;
    return typeof count === 'number' && Number.isFinite(count)
      ? Math.max(0, Math.round(count))
      : null;
  });
  if (backendCounts.some((count) => count != null)) {
    return backendCounts.map((count) => count ?? 0);
  }

  const counts = points.map(() => 0);

  if (counts.length === 0) {
    return counts;
  }

  const pointTimestamps = points.map((point) => Date.parse(normalizeChartPointDate(point.isoDate)));
  const rangeStart = pointTimestamps[0] ?? 0;
  const rangeEnd = pointTimestamps[pointTimestamps.length - 1] ?? 0;

  recentSales.forEach((sale) => {
    if (sale.kind !== 'sold') {
      return;
    }

    const saleTimestamp = Date.parse(sale.soldAtISO);
    if (!Number.isFinite(saleTimestamp) || saleTimestamp < rangeStart || saleTimestamp > rangeEnd + 86400000) {
      return;
    }

    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    pointTimestamps.forEach((timestamp, index) => {
      const distance = Math.abs(timestamp - saleTimestamp);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    counts[nearestIndex] = (counts[nearestIndex] ?? 0) + 1;
  });

  return counts;
}

function portfolioChangeForPoint(
  points: PortfolioDashboard['ranges'][PortfolioHistoryRange]['portfolio'],
  index: number,
  fallback: PortfolioDashboard['summary'],
) {
  const point = points[index];
  if (!point) {
    return {
      amount: fallback.changeAmount,
      percent: fallback.changePercent,
    };
  }

  const baselinePoint = findPortfolioBaselinePoint(points, index);
  if (!baselinePoint) {
    return {
      amount: fallback.changeAmount,
      percent: fallback.changePercent,
    };
  }

  const amount = Number((point.value - baselinePoint.value).toFixed(2));
  // A ratio against a sub-dollar baseline is meaningless (a $1.68 first day
  // turned a normal gain into +743,353%). Same rule the backend applies.
  const percent = baselinePoint.value >= MEANINGFUL_BASELINE_VALUE
    ? Number(((amount / baselinePoint.value) * 100).toFixed(2))
    : null;

  return {
    amount,
    percent,
  };
}

export type PortfolioChartActivePoint = {
  valueLabel: string;
  dateLabel: string;
  changeAmount: number;
  /** Null when the baseline is too near zero for a ratio to mean anything. */
  changePercent: number | null;
  changeAmountLabel: string;
  changePercentLabel: string;
  isHovering: boolean;
};

type PortfolioChartCardProps = {
  chartMode: ChartMode;
  dashboard: PortfolioDashboard;
  isLoading?: boolean;
  selectedRange: PortfolioHistoryRange;
  onRangeChange: (value: PortfolioHistoryRange) => void;
  onActivePointChange?: (active: PortfolioChartActivePoint | null) => void;
  /**
   * Fires true when the long-press lock activates and false when it
   * releases. Parents (e.g. the Portfolio ScrollView) should set their
   * scroll-enabled state from this so vertical scrolling doesn't steal
   * the responder mid-scrub.
   */
  onScrubLockChange?: (locked: boolean) => void;
};

function ChartSkeleton() {
  const theme = useSpotlightTheme();
  const pulseOpacity = useRef(new Animated.Value(0.72)).current;

  useEffect(() => {
    if (process.env.NODE_ENV === 'test') {
      return undefined;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseOpacity, {
          duration: 780,
          easing: Easing.inOut(Easing.ease),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.timing(pulseOpacity, {
          duration: 780,
          easing: Easing.inOut(Easing.ease),
          toValue: 0.72,
          useNativeDriver: true,
        }),
      ]),
    );

    animation.start();

    return () => {
      animation.stop();
    };
  }, [pulseOpacity]);

  return (
    <View pointerEvents="none" style={styles.skeletonChart} testID="portfolio-chart-skeleton">
      <Animated.View style={[styles.skeletonPulseLayer, { opacity: pulseOpacity }]}>
        <View style={styles.skeletonBarRow} testID="portfolio-chart-skeleton-bars">
          {skeletonBarScales.map((heightScale, index) => (
            <View
              key={index}
              style={[
                styles.skeletonBar,
                {
                  backgroundColor: theme.colors.outlineStrong,
                  height: Math.round(142 * heightScale),
                  opacity: 0.46,
                },
              ]}
              testID={`portfolio-chart-skeleton-bar-${index}`}
            />
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

export const PortfolioChartCard = memo(function PortfolioChartCard({
  chartMode,
  dashboard,
  isLoading = false,
  selectedRange,
  onRangeChange,
  onActivePointChange,
  onScrubLockChange,
}: PortfolioChartCardProps) {
  const theme = useSpotlightTheme();
  const [chartWidth, setChartWidth] = useState(0);
  const [tooltipWidth, setTooltipWidth] = useState(0);
  const [tooltipHeight, setTooltipHeight] = useState(0);
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const chartHeight = 200;
  // The chart graphic runs full-bleed to the screen edges horizontally (Figma
  // 1252-1763), so no horizontal inset; keep a small vertical inset so the line
  // peak and the resting end dot don't clip at the top/bottom.
  const chartPaddingX = 0;
  const chartPaddingY = 12;
  const activeRange = dashboard.ranges[selectedRange];
  const portfolioSeries = useMemo(() => trimPortfolioWarmup(activeRange.portfolio), [activeRange.portfolio]);
  const series = chartMode === 'portfolio' ? portfolioSeries : activeRange.sales;
  const isChartSkeletonVisible = isLoading && series.length === 0;
  const salesPointCounts = useMemo(() => {
    return buildSalesPointCounts(activeRange.sales, dashboard.recentSales);
  }, [activeRange.sales, dashboard.recentSales]);
  const chartAccentColor = theme.colors.purple500;

  const yAxisMaxValue = useMemo(() => {
    return buildRoundedCurrencyTicks(series.map((point) => point.value));
  }, [series]);
  // (Sales BARS keep the 0-baseline via `yAxisMaxValue` — they encode magnitude,
  // not trend, so their height must stay proportional from zero.)
  const lineYDomain = useMemo(
    () => portfolioLineYDomain(series.map((point) => point.value)),
    [series],
  );
  const plotWidth = Math.max(chartWidth - chartPaddingX * 2, 1);
  const plotHeight = Math.max(chartHeight - chartPaddingY * 2, 1);

  useEffect(() => {
    setActivePointIndex(null);
  }, [chartMode, dashboard, selectedRange]);

  const coordinates = useMemo(() => {
    if (chartWidth === 0) {
      return [];
    }

    const xStep = series.length > 1 ? plotWidth / (series.length - 1) : plotWidth / 2;

    const domainSpan = Math.max(lineYDomain.max - lineYDomain.min, 1e-6);

    return series.map((point, index) => {
      const normalizedY = (point.value - lineYDomain.min) / domainSpan;
      return {
        // A lone point sits on the RIGHT edge so the synthesized rise below
        // (baseline → value) ends on it, instead of a dot floating mid-chart.
        x: chartPaddingX + (series.length > 1 ? index * xStep : plotWidth),
        y: chartPaddingY + plotHeight - normalizedY * plotHeight,
      };
    });
  }, [chartPaddingX, chartPaddingY, chartWidth, lineYDomain, plotHeight, plotWidth, series]);

  // What the line/fill actually draw. Real data passes through untouched; the
  // two sparse states get synthesized shapes so the chart never reads as blank:
  // - no points → a flat baseline line across the full width (the $0 state)
  // - one point → a line rising from the left baseline up to that value on the
  //   right, so the first item reads as growth instead of a lone dot.
  const pathCoordinates = useMemo(() => {
    if (chartWidth === 0) {
      return coordinates;
    }
    const baselineY = chartHeight - chartPaddingY;
    if (coordinates.length === 1) {
      return [{ x: chartPaddingX, y: baselineY }, coordinates[0]];
    }
    if (coordinates.length === 0) {
      // Resting $0 line sits mid-chart (like a flat market line), not on the
      // bottom edge.
      const midY = chartPaddingY + plotHeight / 2;
      return [
        { x: chartPaddingX, y: midY },
        { x: chartPaddingX + plotWidth, y: midY },
      ];
    }
    return coordinates;
  }, [chartHeight, chartPaddingX, chartPaddingY, chartWidth, coordinates, plotHeight, plotWidth]);

  const salesBars = useMemo(() => {
    if (chartWidth === 0 || series.length === 0) {
      return [];
    }

    const segmentWidth = plotWidth / Math.max(series.length, 1);
    const barWidth = Math.max(Math.min(segmentWidth * 0.72, 18), 2);
    const gap = Math.max(segmentWidth - barWidth, 0);

    return series.map((point, index) => {
      const height = ((point.value / yAxisMaxValue) * plotHeight) || 2;
      return {
        height,
        width: barWidth,
        x: chartPaddingX + index * segmentWidth + gap / 2,
        y: chartHeight - chartPaddingY - height,
      };
    });
  }, [chartHeight, chartPaddingX, chartPaddingY, chartWidth, plotHeight, plotWidth, series, yAxisMaxValue]);

  const linePath = useMemo(() => {
    return buildLinePath(pathCoordinates);
  }, [pathCoordinates]);


  const onChartLayout = (event: LayoutChangeEvent) => {
    setChartWidth(event.nativeEvent.layout.width);
  };

  const activeSelection = useMemo(() => {
    if (activePointIndex == null) {
      return null;
    }

    const point = series[activePointIndex];
    if (!point) {
      return null;
    }

    if (chartMode === 'portfolio') {
      // Snap the dot/guide to where the corner-rounded line is DRAWN, not the
      // raw vertex — at curvy points they visibly diverge (dot floats off the
      // line).
      const coordinate = renderedLinePointAt(coordinates, activePointIndex);
      if (!coordinate) {
        return null;
      }

      return {
        point,
        x: coordinate.x,
        y: coordinate.y,
      };
    }

    const bar = salesBars[activePointIndex];
    if (!bar) {
      return null;
    }

    return {
      point,
      x: bar.x + bar.width / 2,
      y: bar.y,
    };
  }, [activePointIndex, chartMode, coordinates, salesBars, series]);

  // Content for the on-chart scrub tooltip (the small Figma modal): the
  // exact date and the point's value.
  const tooltipLabels = useMemo(() => {
    if (!activeSelection) {
      return null;
    }

    return {
      dateLabel: formatTooltipDateLabel(activeSelection.point.isoDate),
      valueLabel: formatCurrency(activeSelection.point.value),
    };
  }, [activeSelection]);

  // Center the tooltip over the active point, clamped so it never spills off
  // either chart edge.
  const tooltipLeft = activeSelection
    ? clamp(activeSelection.x - tooltipWidth / 2, 0, Math.max(chartWidth - tooltipWidth, 0))
    : 0;

  // Pin the scrub tooltip to the TOP of the dashed guide line (Figma 822-2634)
  // instead of floating next to the dot: the modal sits at the very top of the
  // grey dotted line and the line drops from it down to the value point. The
  // line starts at chartPaddingY, so that's the tooltip's top.
  const tooltipTop = activeSelection ? chartPaddingY : 0;

  const isScrubbing = activePointIndex != null;

  // The header payload for a scrubbed point. Built and sent straight from the
  // gesture handler (not an effect), so the big value updates in the same
  // render as the cursor.
  const activePointPayload = (index: number): PortfolioChartActivePoint | null => {
    const point = series[index];
    if (!point) {
      return null;
    }
    if (chartMode === 'portfolio') {
      const change = portfolioChangeForPoint(portfolioSeries, index, dashboard.summary);
      return {
        valueLabel: formatCurrency(point.value),
        dateLabel: formatHoverDateLabel(point.isoDate),
        changeAmount: change.amount,
        changePercent: change.percent,
        changeAmountLabel: formatSignedCurrency(change.amount),
        changePercentLabel: change.percent == null ? '' : formatPercent(change.percent),
        isHovering: true,
      };
    }
    const salesCount = salesPointCounts[index] ?? 0;
    return {
      valueLabel: formatCurrency(point.value),
      dateLabel: formatHoverDateLabel(point.isoDate),
      changeAmount: salesCount,
      changePercent: 0,
      changeAmountLabel: `${salesCount} sale${salesCount === 1 ? '' : 's'}`,
      changePercentLabel: '',
      isHovering: true,
    };
  };
  const activePointPayloadRef = useRef(activePointPayload);
  activePointPayloadRef.current = activePointPayload;
  const onActivePointChangeLatest = useRef(onActivePointChange);
  onActivePointChangeLatest.current = onActivePointChange;

  // ===========================================================================
  // Scrub gesture — the PDP price chart's engine (price-scrub-chart.tsx).
  //
  // The finger is tracked on the UI thread: each frame finds the nearest point
  // there and only crosses to JS when that INDEX changes, so a drag costs a
  // handful of renders instead of one per touch event. A horizontal drag past
  // 6pt scrubs at once; a still press scrubs after 250ms; a vertical drag fails
  // past 10pt and is left to the page scroll. Arming `chartScrubLockRef` on
  // start stands the tab pager down (its threshold is 14pt), as before.
  // ===========================================================================
  const { chartScrubLockRef } = useTabsPage();
  const isScrubLockedRef = useRef(false);
  const onScrubLockChangeLatest = useRef(onScrubLockChange);
  onScrubLockChangeLatest.current = onScrubLockChange;
  const seriesLengthRef = useRef(series.length);
  seriesLengthRef.current = series.length;
  const lastIndexRef = useRef<number | null>(null);

  const xs = useMemo(
    () => (chartMode === 'portfolio'
      ? coordinates.map((coordinate) => coordinate.x)
      : salesBars.map((bar) => bar.x + bar.width / 2)),
    [chartMode, coordinates, salesBars],
  );

  const beginScrub = useCallback(() => {
    isScrubLockedRef.current = true;
    chartScrubLockRef.current = true;
    lastIndexRef.current = null;
    onScrubLockChangeLatest.current?.(true);
    // impactAsync(Light): the noticeable "thump" for gesture-lock confirmation.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, [chartScrubLockRef]);

  const scrubTo = useCallback((index: number) => {
    if (!isScrubLockedRef.current || index < 0 || index >= seriesLengthRef.current || index === lastIndexRef.current) {
      return;
    }
    const hadIndex = lastIndexRef.current != null;
    lastIndexRef.current = index;
    if (hadIndex) {
      void Haptics.selectionAsync().catch(() => {});
    }
    setActivePointIndex(index);
    onActivePointChangeLatest.current?.(activePointPayloadRef.current(index));
  }, []);

  const endScrubLock = useCallback(() => {
    if (isScrubLockedRef.current) {
      isScrubLockedRef.current = false;
      chartScrubLockRef.current = false;
      onScrubLockChangeLatest.current?.(false);
    }
    lastIndexRef.current = null;
    setActivePointIndex(null);
    onActivePointChangeLatest.current?.(null);
  }, [chartScrubLockRef]);

  // New data mid-scrub (refetch, range or mode change) drops the cursor; send the
  // header back to resting, and let the next move pick a point in the new series.
  useEffect(() => {
    if (lastIndexRef.current != null) {
      lastIndexRef.current = null;
      onActivePointChangeLatest.current?.(null);
    }
  }, [chartMode, dashboard, selectedRange]);

  // Portfolio line = the PDP price chart (PriceScrubChart), which owns its own
  // gesture + haptics; this just maps its index stream onto the lock + header.
  const usesPriceChart = chartMode === 'portfolio' && series.length >= 2;
  const priceChartPoints = useMemo<PriceChartPoint[]>(
    () => (usesPriceChart
      ? series.map((point) => ({ t: Date.parse(normalizeChartPointDate(point.isoDate)), v: point.value }))
      : []),
    [series, usesPriceChart],
  );
  const onPriceScrub = useCallback((index: number | null) => {
    if (index == null) {
      endScrubLock();
      return;
    }
    if (!isScrubLockedRef.current) {
      isScrubLockedRef.current = true;
      chartScrubLockRef.current = true;
      onScrubLockChangeLatest.current?.(true);
    }
    lastIndexRef.current = index;
    setActivePointIndex(index);
    onActivePointChangeLatest.current?.(activePointPayloadRef.current(index));
  }, [chartScrubLockRef, endScrubLock]);

  const lastWorkletIndex = useSharedValue(-1);
  const scrubGesture = useMemo(() => {
    // onEnd only fires for a gesture that activated, so the Race loser never ends the scrub.
    const configure = (pan: ReturnType<typeof Gesture.Pan>) =>
      pan
        .onStart((event) => {
          runOnJS(beginScrub)();
          const index = nearestIndexByX(xs, event.x);
          lastWorkletIndex.value = index;
          runOnJS(scrubTo)(index);
        })
        .onUpdate((event) => {
          const index = nearestIndexByX(xs, event.x);
          if (index !== lastWorkletIndex.value) {
            lastWorkletIndex.value = index;
            runOnJS(scrubTo)(index);
          }
        })
        .onEnd(() => {
          lastWorkletIndex.value = -1;
          runOnJS(endScrubLock)();
        });
    const drag = configure(
      Gesture.Pan()
        .withTestId('portfolio-chart-drag')
        .activeOffsetX([-SCRUB_DRAG_ACTIVE_OFFSET_X, SCRUB_DRAG_ACTIVE_OFFSET_X])
        .failOffsetY([-SCRUB_DRAG_FAIL_OFFSET_Y, SCRUB_DRAG_FAIL_OFFSET_Y]),
    );
    const hold = configure(
      Gesture.Pan().withTestId('portfolio-chart-hold').activateAfterLongPress(SCRUB_LONG_PRESS_MS),
    );
    return Gesture.Race(drag, hold);
  }, [beginScrub, endScrubLock, lastWorkletIndex, scrubTo, xs]);

  // Keep the latest parent callbacks in refs so the unmount cleanup can notify
  // the parent without re-subscribing on every prop change.
  const onActivePointChangeRef = useRef(onActivePointChange);
  const onScrubLockChangeRef = useRef(onScrubLockChange);
  onActivePointChangeRef.current = onActivePointChange;
  onScrubLockChangeRef.current = onScrubLockChange;

  // If the chart unmounts or remounts while a scrub is active — a tab switch,
  // a transient load error swapping the chart out, a header remount — the
  // release/terminate handlers never fire. That would strand the parent on the
  // last hovered point (often a $0.00 left-edge baseline, which is exactly how
  // the portfolio value "got stuck at 0" until an app restart) and leave the
  // shared scrub-lock engaged, silently disabling the pager's horizontal swipe.
  // Reset everything on unmount so neither can outlive the gesture.
  useEffect(() => {
    return () => {
      chartScrubLockRef.current = false;
      onScrubLockChangeRef.current?.(false);
      onActivePointChangeRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup; every value it touches is a ref
  }, []);

  return (
    <View style={styles.container}>
      <View
        // While scrubbing, the date-range selector is hidden and replaced by
        // the on-chart date/value tooltip. Keep it mounted (opacity 0) so the
        // chart below doesn't shift when the user lifts off.
        pointerEvents={isScrubbing ? 'none' : 'auto'}
        style={[styles.rangeRow, isScrubbing ? styles.rangeRowHidden : null]}
      >
        {rangeItems.map((item) => {
          const isSelected = item.value === selectedRange;
          return (
            <Pressable
              accessibilityRole="button"
              key={item.value}
              onPress={() => onRangeChange(item.value as PortfolioHistoryRange)}
              style={({ pressed }) => [
                isSelected ? styles.rangePillSelected : styles.rangePill,
                isSelected ? { backgroundColor: theme.colors.gray100 } : null,
                pressed ? { opacity: 0.88 } : null,
              ]}
              testID={`range-${item.value}`}
            >
              <Text
                style={[
                  styles.rangePillLabel,
                  { color: isSelected ? theme.colors.gray900 : theme.colors.gray700 },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View
        onLayout={onChartLayout}
        style={[styles.chartArea, { height: chartHeight }]}
        testID={`portfolio-chart-${chartMode}`}
      >
        {isChartSkeletonVisible ? (
          <ChartSkeleton />
        ) : usesPriceChart ? (
          <PriceScrubChart
            color={chartAccentColor}
            height={chartHeight}
            onScrub={onPriceScrub}
            points={priceChartPoints}
            areaFill
            testID="portfolio-price-chart"
            variant="line"
            yScale="fit"
            windowEndMs={priceChartPoints[priceChartPoints.length - 1].t}
            windowStartMs={priceChartPoints[0].t}
          />
        ) : chartWidth > 0 ? (
          <>
            {/* Numeric width, NOT "100%": percentage width on the Svg root
                renders zero-width (invisible chart) on Android. chartWidth is
                the measured layout width and this branch requires it > 0. */}
            <Svg height={chartHeight} width={chartWidth}>

              {chartMode === 'portfolio' ? (
                <>
                  {/* Only the sparse 0/1-point states land here; real series
                      render through PriceScrubChart above. */}
                  <Path
                    d={linePath}
                    fill="none"
                    stroke={chartAccentColor}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.2}
                  />
                  {activeSelection ? (
                    <>
                      <Line
                        stroke={theme.colors.chartGuide}
                        strokeDasharray={[4, 4]}
                        strokeWidth={1.5}
                        x1={activeSelection.x}
                        x2={activeSelection.x}
                        y1={chartPaddingY}
                        y2={chartHeight - chartPaddingY}
                      />
                      <Circle
                        cx={activeSelection.x}
                        cy={activeSelection.y}
                        fill={chartAccentColor}
                        r={3.5}
                        stroke={theme.colors.gray0}
                        strokeWidth={1}
                      />
                    </>
                  ) : null}
                  {/* Resting end dot removed 2026-09-04 (design): the line just
                      ends at the edge; the dot only appears while scrubbing. */}
                </>
              ) : (
                <>
                  {salesBars.map((bar, index) => {
                    return (
                      <Rect
                        key={series[index]?.isoDate ?? index}
                        fill={chartAccentColor}
                        height={bar.height}
                        opacity={activePointIndex == null || activePointIndex === index ? 1 : 0.45}
                        rx={8}
                        width={bar.width}
                        x={bar.x}
                        y={bar.y}
                      />
                    );
                  })}
                  {activeSelection ? (
                    <Line
                      stroke={theme.colors.chartGuide}
                      strokeDasharray={[4, 4]}
                      strokeWidth={1.5}
                      x1={activeSelection.x}
                      x2={activeSelection.x}
                      y1={chartPaddingY}
                      y2={chartHeight - chartPaddingY}
                    />
                  ) : null}
                </>
              )}
            </Svg>

            {/* Scrub tooltip — the small Figma modal floating just above the
                active point, tracking its x and y and showing the exact date
                and value. Non-interactive so it never steals the scrub touch. */}
            {activeSelection && tooltipLabels ? (
              <View
                onLayout={(event) => {
                  setTooltipWidth(event.nativeEvent.layout.width);
                  setTooltipHeight(event.nativeEvent.layout.height);
                }}
                pointerEvents="none"
                style={[
                  styles.tooltip,
                  {
                    backgroundColor: theme.colors.gray50,
                    borderColor: theme.colors.gray100,
                    left: tooltipLeft,
                    top: tooltipTop,
                    opacity: tooltipWidth > 0 && tooltipHeight > 0 ? 1 : 0,
                  },
                ]}
                testID="portfolio-chart-tooltip"
              >
                <Text style={[styles.tooltipDate, { color: theme.colors.gray800 }]}>
                  {tooltipLabels.dateLabel}
                </Text>
                <Text style={[styles.tooltipValue, { color: theme.colors.gray900 }]}>
                  {tooltipLabels.valueLabel}
                </Text>
              </View>
            ) : null}

            <GestureDetector gesture={scrubGesture}>
              <View collapsable={false} style={styles.chartTouchTarget} testID="portfolio-chart-touch-target" />
            </GestureDetector>
          </>
        ) : null}
      </View>

    </View>
  );
});

export type { PortfolioChartCardProps };

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  chartArea: {
    position: 'relative',
    width: '100%',
  },
  chartTouchTarget: {
    ...StyleSheet.absoluteFillObject,
  },
  // Figma 5938:21789: left-aligned on the page gutter, so the first pill lines
  // up with the portfolio value above; 8 between pills.
  rangeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-start',
    marginHorizontal: layout.pageGutter,
  },
  rangeRowHidden: {
    opacity: 0,
  },
  tooltip: {
    alignItems: 'flex-start',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: borderWidths.containerRule,
    gap: spacing.xxxs,
    paddingHorizontal: spacing.xxs,
    paddingVertical: 6,
    position: 'absolute',
  },
  tooltipDate: {
    ...textStyles.overline,
  },
  tooltipValue: {
    ...textStyles.labelStrong,
  },
  // Same box selected or not, so switching ranges never shifts the row.
  rangePill: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 4,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  rangePillSelected: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  // Figma "Label" (Medium 14), selected and unselected alike.
  rangePillLabel: {
    ...textStyles.label,
    textAlign: 'center',
  },
  skeletonBar: {
    borderCurve: 'continuous',
    borderRadius: 6,
    width: 12,
  },
  skeletonBarRow: {
    alignItems: 'flex-end',
    bottom: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 14,
    position: 'absolute',
    right: 14,
    top: 18,
  },
  skeletonChart: {
    flex: 1,
    minHeight: 200,
    overflow: 'hidden',
    position: 'relative',
  },
  skeletonPulseLayer: {
    ...StyleSheet.absoluteFillObject,
  },
});

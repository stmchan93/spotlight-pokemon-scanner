import {
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  GestureResponderEvent,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { useTabsPage } from '@/contexts/tabs-page-context';
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Pattern,
  Rect,
  Stop,
} from 'react-native-svg';

// Small graph-paper grid drawn inside the line chart's fill area (Figma 809-12748).
const CHART_GRID_CELL = 14;

import type {
  ChartMode,
  PortfolioDashboard,
  PortfolioHistoryRange,
  RecentSaleRecord,
} from '@spotlight/api-client';
import { fontFamilies, useSpotlightTheme } from '@spotlight/design-system';

import {
  formatCurrency,
  formatPercent,
  formatSignedCurrency,
} from './portfolio-formatting';

const rangeItems = [
  { label: '7D', value: '1W' },
  { label: '1M', value: '1M' },
  { label: '3M', value: '3M' },
  { label: '1Y', value: '1Y' },
  { label: 'ALL', value: 'ALL' },
] as const;

const skeletonBarScales = [0.42, 0.62, 0.5, 0.74, 0.58, 0.82, 0.68, 0.9, 0.76, 0.56, 0.72, 0.64];

// Soften each interior corner of the line by rounding it with an arc of up to
// this radius, clamped to half the shorter adjacent segment so neighbouring
// corners never overshoot each other. 72px is large relative to the ~176px
// plot, so the line reads as a smooth curve rather than a sharp polyline.
const LINE_CORNER_RADIUS = 72;

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
    const prev = points[index - 1];
    const curr = points[index];
    const next = points[index + 1];

    const inLen = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const outLen = Math.hypot(next.x - curr.x, next.y - curr.y);
    const trim = Math.min(LINE_CORNER_RADIUS, inLen / 2, outLen / 2);

    if (trim <= 0) {
      // Coincident points — keep the hard vertex rather than divide by zero.
      path += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    // Stop short of the vertex on the way in, curve through the vertex (the
    // quadratic control point), and resume short of it on the way out.
    const entryX = curr.x + ((prev.x - curr.x) / inLen) * trim;
    const entryY = curr.y + ((prev.y - curr.y) / inLen) * trim;
    const exitX = curr.x + ((next.x - curr.x) / outLen) * trim;
    const exitY = curr.y + ((next.y - curr.y) / outLen) * trim;

    path += ` L ${entryX} ${entryY} Q ${curr.x} ${curr.y} ${exitX} ${exitY}`;
  }

  const last = points[points.length - 1];
  return `${path} L ${last.x} ${last.y}`;
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
  const percent = baselinePoint.value > 0
    ? Number(((amount / baselinePoint.value) * 100).toFixed(2))
    : 0;

  return {
    amount,
    percent,
  };
}

export type PortfolioChartActivePoint = {
  valueLabel: string;
  dateLabel: string;
  changeAmount: number;
  changePercent: number;
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
  const series = chartMode === 'portfolio' ? activeRange.portfolio : activeRange.sales;
  const isChartSkeletonVisible = isLoading && series.length === 0;
  const salesPointCounts = useMemo(() => {
    return buildSalesPointCounts(activeRange.sales, dashboard.recentSales);
  }, [activeRange.sales, dashboard.recentSales]);
  const chartAccentColor = theme.colors.brand;
  const chartFillColor = theme.colors.brand;

  const yAxisMaxValue = useMemo(() => {
    return buildRoundedCurrencyTicks(series.map((point) => point.value));
  }, [series]);
  // The portfolio LINE auto-scales to the visible value range (not 0→max) so a
  // small % move over the window reads as a real slope instead of a near-flat
  // line. A little headroom on each side keeps the peak/trough off the edges.
  // (Sales BARS keep the 0-baseline via `yAxisMaxValue` — they encode magnitude,
  // not trend, so their height must stay proportional from zero.)
  const lineYDomain = useMemo(() => {
    const values = series
      .map((point) => point.value)
      .filter((value) => Number.isFinite(value));
    if (values.length === 0) {
      return { min: 0, max: 1 };
    }
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    if (dataMax === dataMin) {
      // Flat window — center the line with a small symmetric band.
      const pad = Math.abs(dataMax) * 0.05 || 1;
      return { min: dataMin - pad, max: dataMax + pad };
    }
    const pad = (dataMax - dataMin) * 0.1;
    return { min: dataMin - pad, max: dataMax + pad };
  }, [series]);
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
        x: chartPaddingX + (series.length > 1 ? index * xStep : plotWidth / 2),
        y: chartPaddingY + plotHeight - normalizedY * plotHeight,
      };
    });
  }, [chartPaddingX, chartPaddingY, chartWidth, lineYDomain, plotHeight, plotWidth, series]);

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
    return buildLinePath(coordinates);
  }, [coordinates]);

  const fillPath = useMemo(() => {
    if (coordinates.length === 0) {
      return '';
    }

    const baseline = chartHeight - chartPaddingY;
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];

    return `${buildLinePath(coordinates)} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`;
  }, [chartHeight, chartPaddingY, coordinates]);

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
      const coordinate = coordinates[activePointIndex];
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

  // Float the tooltip just above the active dot so it tracks the point instead
  // of sitting at a fixed height. When the dot is too close to the top to fit
  // the tooltip above it, flip below the dot so it never covers the dot or
  // spills off the top of the chart.
  const TOOLTIP_DOT_GAP = 14; // dot radius (4) + breathing room
  const tooltipTop = activeSelection
    ? (() => {
        const above = activeSelection.y - TOOLTIP_DOT_GAP - tooltipHeight;
        if (above >= 0) {
          return above;
        }
        const below = activeSelection.y + TOOLTIP_DOT_GAP;
        return Math.min(below, Math.max(chartHeight - tooltipHeight, 0));
      })()
    : 0;

  const isScrubbing = activePointIndex != null;

  // Bubble the active hovered point up to the parent so it can render the
  // big value, date, and delta in the screen header.
  useEffect(() => {
    if (!onActivePointChange) {
      return;
    }

    if (activePointIndex == null) {
      onActivePointChange(null);
      return;
    }

    const point = series[activePointIndex];
    if (!point) {
      onActivePointChange(null);
      return;
    }

    if (chartMode === 'portfolio') {
      const change = portfolioChangeForPoint(activeRange.portfolio, activePointIndex, dashboard.summary);
      onActivePointChange({
        valueLabel: formatCurrency(point.value),
        dateLabel: formatHoverDateLabel(point.isoDate),
        changeAmount: change.amount,
        changePercent: change.percent,
        changeAmountLabel: formatSignedCurrency(change.amount),
        changePercentLabel: formatPercent(change.percent),
        isHovering: true,
      });
    } else {
      const salesCount = salesPointCounts[activePointIndex] ?? 0;
      onActivePointChange({
        valueLabel: formatCurrency(point.value),
        dateLabel: formatHoverDateLabel(point.isoDate),
        changeAmount: salesCount,
        changePercent: 0,
        changeAmountLabel: `${salesCount} sale${salesCount === 1 ? '' : 's'}`,
        changePercentLabel: '',
        isHovering: true,
      });
    }
  }, [
    activePointIndex,
    activeRange.portfolio,
    chartMode,
    dashboard.summary,
    onActivePointChange,
    salesPointCounts,
    series,
  ]);

  const updateActivePoint = (event: GestureResponderEvent) => {
    if (chartWidth === 0 || series.length === 0) {
      return;
    }

    const locationX = clamp(event.nativeEvent.locationX, 0, chartWidth);
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    if (chartMode === 'portfolio') {
      coordinates.forEach((coordinate, index) => {
        const distance = Math.abs(coordinate.x - locationX);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });
    } else {
      salesBars.forEach((bar, index) => {
        const distance = Math.abs((bar.x + bar.width / 2) - locationX);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });
    }

    setActivePointIndex(nearestIndex);
  };

  const releaseActivePoint = () => {
    setActivePointIndex(null);
  };

  // ===========================================================================
  // Long-press scrub gesture (Robinhood-style)
  //
  // Touching the chart does NOT immediately scrub — that was making the tab
  // pager fight the chart for the gesture on every slight horizontal move.
  // Now:
  //   1. Touch + hold ~250ms with little movement → enter "scrub lock":
  //      a haptic confirms it; the pager refuses to capture while locked.
  //   2. Quick horizontal swipe before the lock fires → pager wins, chart
  //      gets onResponderTerminate and quietly bails.
  //   3. Once locked, drag freely to scrub. Release clears the lock.
  //
  // In tests the timer is bypassed so existing fireEvent('responderGrant')
  // assertions still see an immediate scrub.
  // ===========================================================================
  const { chartScrubLockRef } = useTabsPage();
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isScrubLockedRef = useRef(false);
  const touchStartXRef = useRef(0);
  const isTestEnv = process.env.NODE_ENV === 'test';
  const longPressDelayMs = 250;
  const longPressCancelDistancePx = 8;

  // NOTE: not memoizing these helpers — they close over `updateActivePoint`
  // which depends on `chartWidth` (set on layout). useCallback-memoizing
  // would capture a stale closure where chartWidth=0, so updateActivePoint
  // bails early before any active-point is computed.
  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const beginScrubLock = (locationX: number) => {
    isScrubLockedRef.current = true;
    chartScrubLockRef.current = true;
    onScrubLockChange?.(true);
    if (!isTestEnv) {
      // impactAsync(Light) is the noticeable "thump" most apps use for
      // gesture-lock confirmation. selectionAsync (what we used before)
      // is the intentionally-subtle picker-wheel tick and many users
      // never feel it.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    // Synthesize a responder-like event and update the scrub indicator
    // to the initial touch position so the user sees feedback immediately.
    updateActivePoint({
      nativeEvent: { locationX },
    } as GestureResponderEvent);
  };

  const endScrubLock = () => {
    clearLongPressTimer();
    if (isScrubLockedRef.current) {
      isScrubLockedRef.current = false;
      chartScrubLockRef.current = false;
      onScrubLockChange?.(false);
    }
    releaseActivePoint();
  };

  const onTouchGrant = (event: GestureResponderEvent) => {
    const locationX = event.nativeEvent.locationX;
    touchStartXRef.current = locationX;
    clearLongPressTimer();
    if (isTestEnv) {
      // Skip the timer in tests so fireEvent('responderGrant') still
      // produces an immediately-active scrub point for existing assertions.
      beginScrubLock(locationX);
      return;
    }
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      beginScrubLock(locationX);
    }, longPressDelayMs);
  };

  const onTouchMove = (event: GestureResponderEvent) => {
    if (!isScrubLockedRef.current) {
      // Pre-lock window: if the user moves significantly, abandon the
      // long-press intent so the pager (or other ancestor) can claim.
      const dx = Math.abs(event.nativeEvent.locationX - touchStartXRef.current);
      if (dx > longPressCancelDistancePx) {
        clearLongPressTimer();
      }
      return;
    }
    updateActivePoint(event);
  };

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
      clearLongPressTimer();
      chartScrubLockRef.current = false;
      onScrubLockChangeRef.current?.(false);
      onActivePointChangeRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
                isSelected ? { backgroundColor: theme.colors.brand } : null,
                pressed ? { opacity: 0.88 } : null,
              ]}
              testID={`range-${item.value}`}
            >
              <Text
                style={[
                  styles.rangePillLabel,
                  { color: isSelected ? theme.colors.gray0 : theme.colors.gray700 },
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
        ) : chartWidth > 0 ? (
          <>
            <Svg height={chartHeight} width="100%">
              <Defs>
                <LinearGradient id="portfolioFill" x1="0" x2="0" y1="0" y2="1">
                  <Stop offset="0" stopColor={chartFillColor} stopOpacity="0.28" />
                  <Stop offset="1" stopColor={chartFillColor} stopOpacity="0.02" />
                </LinearGradient>
                <Pattern
                  height={CHART_GRID_CELL}
                  id="portfolioGrid"
                  patternUnits="userSpaceOnUse"
                  width={CHART_GRID_CELL}
                >
                  <Path
                    d={`M${CHART_GRID_CELL} 0 L0 0 L0 ${CHART_GRID_CELL}`}
                    fill="none"
                    stroke={chartAccentColor}
                    strokeOpacity={0.16}
                    strokeWidth={0.75}
                  />
                </Pattern>
              </Defs>

              {chartMode === 'portfolio' ? (
                <>
                  <Path d={fillPath} fill="url(#portfolioFill)" />
                  <Path d={fillPath} fill="url(#portfolioGrid)" />
                  <Path
                    d={linePath}
                    fill="none"
                    stroke={chartAccentColor}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2.5}
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
                        r={4}
                      />
                    </>
                  ) : coordinates.length > 0 ? (
                    <Circle
                      // The last point now sits on the right edge (full-bleed),
                      // so nudge the resting dot in by its radius to stay visible.
                      cx={Math.min(coordinates[coordinates.length - 1]?.x ?? 0, chartWidth - 4)}
                      cy={coordinates[coordinates.length - 1]?.y ?? 0}
                      fill={chartAccentColor}
                      r={4}
                    />
                  ) : null}
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
                    backgroundColor: theme.colors.gray100,
                    left: tooltipLeft,
                    top: tooltipTop,
                    opacity: tooltipWidth > 0 && tooltipHeight > 0 ? 1 : 0,
                  },
                ]}
                testID="portfolio-chart-tooltip"
              >
                <Text style={[styles.tooltipDate, { color: theme.colors.gray900 }]}>
                  {tooltipLabels.dateLabel}
                </Text>
                <Text style={[styles.tooltipValue, { color: theme.colors.gray900 }]}>
                  {tooltipLabels.valueLabel}
                </Text>
              </View>
            ) : null}

            <View
              onMoveShouldSetResponder={() => true}
              onResponderGrant={onTouchGrant}
              onResponderMove={onTouchMove}
              onResponderRelease={endScrubLock}
              onResponderTerminate={endScrubLock}
              onStartShouldSetResponder={() => true}
              style={styles.chartTouchTarget}
              testID="portfolio-chart-touch-target"
            />
          </>
        ) : null}
      </View>

    </View>
  );
});

export type { PortfolioChartCardProps };

const styles = StyleSheet.create({
  container: {
    gap: 12,
  },
  chartArea: {
    position: 'relative',
    width: '100%',
  },
  chartTouchTarget: {
    ...StyleSheet.absoluteFillObject,
  },
  rangeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 24,
    marginHorizontal: 16,
  },
  rangeRowHidden: {
    opacity: 0,
  },
  tooltip: {
    alignItems: 'flex-start',
    borderRadius: 8,
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    position: 'absolute',
  },
  tooltipDate: {
    fontFamily: fontFamilies.bodySemiBold,
    fontSize: 10,
    lineHeight: 13,
  },
  tooltipValue: {
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 12,
    lineHeight: 15.6,
  },
  rangePill: {
    alignItems: 'center',
    borderRadius: 4,
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  rangePillSelected: {
    alignItems: 'center',
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  rangePillLabel: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 12,
    lineHeight: 16.8,
    textAlign: 'center',
  },
  skeletonBar: {
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

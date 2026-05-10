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
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';

import type {
  ChartMode,
  PortfolioDashboard,
  PortfolioHistoryRange,
  RecentSaleRecord,
} from '@spotlight/api-client';
import { useSpotlightTheme } from '@spotlight/design-system';

import {
  formatCurrency,
  formatPercent,
  formatSignedCurrency,
} from './portfolio-formatting';

const rangeItems = [
  { label: '1W', value: '1W' },
  { label: '1M', value: '1M' },
  { label: '3M', value: '3M' },
  { label: 'YTD', value: 'YTD' },
  { label: '1Y', value: '1Y' },
  { label: 'All', value: 'ALL' },
] as const;

const skeletonBarScales = [0.42, 0.62, 0.5, 0.74, 0.58, 0.82, 0.68, 0.9, 0.76, 0.56, 0.72, 0.64];

function buildLinePath(points: readonly { x: number; y: number }[]) {
  if (points.length === 0) {
    return '';
  }

  if (points.length === 1) {
    const point = points[0];
    return `M ${point.x} ${point.y}`;
  }

  return points.reduce((path, point, index) => {
    if (index === 0) {
      return `M ${point.x} ${point.y}`;
    }

    return `${path} L ${point.x} ${point.y}`;
  }, '');
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
}: PortfolioChartCardProps) {
  const theme = useSpotlightTheme();
  const [chartWidth, setChartWidth] = useState(0);
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const chartHeight = 200;
  const chartPadding = 12;
  const activeRange = dashboard.ranges[selectedRange];
  const series = chartMode === 'portfolio' ? activeRange.portfolio : activeRange.sales;
  const isChartSkeletonVisible = isLoading && series.length === 0;
  const salesPointCounts = useMemo(() => {
    return buildSalesPointCounts(activeRange.sales, dashboard.recentSales);
  }, [activeRange.sales, dashboard.recentSales]);
  const chartAccentColor = theme.colors.brand;

  const yAxisMaxValue = useMemo(() => {
    return buildRoundedCurrencyTicks(series.map((point) => point.value));
  }, [series]);
  const plotWidth = Math.max(chartWidth - chartPadding * 2, 1);
  const plotHeight = Math.max(chartHeight - chartPadding * 2, 1);

  useEffect(() => {
    setActivePointIndex(null);
  }, [chartMode, dashboard, selectedRange]);

  const coordinates = useMemo(() => {
    if (chartWidth === 0) {
      return [];
    }

    const xStep = series.length > 1 ? plotWidth / (series.length - 1) : plotWidth / 2;

    return series.map((point, index) => {
      const normalizedY = point.value / yAxisMaxValue;
      return {
        x: chartPadding + (series.length > 1 ? index * xStep : plotWidth / 2),
        y: chartPadding + plotHeight - normalizedY * plotHeight,
      };
    });
  }, [chartPadding, chartWidth, plotHeight, plotWidth, series, yAxisMaxValue]);

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
        x: chartPadding + index * segmentWidth + gap / 2,
        y: chartHeight - chartPadding - height,
      };
    });
  }, [chartHeight, chartPadding, chartWidth, plotHeight, plotWidth, series, yAxisMaxValue]);

  const linePath = useMemo(() => {
    return buildLinePath(coordinates);
  }, [coordinates]);

  const fillPath = useMemo(() => {
    if (coordinates.length === 0) {
      return '';
    }

    const baseline = chartHeight - chartPadding;
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];

    return `${buildLinePath(coordinates)} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`;
  }, [chartHeight, chartPadding, coordinates]);

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

  return (
    <View style={styles.container}>
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
                  <Stop offset="0" stopColor={chartAccentColor} stopOpacity="0.28" />
                  <Stop offset="1" stopColor={chartAccentColor} stopOpacity="0.02" />
                </LinearGradient>
              </Defs>

              {chartMode === 'portfolio' ? (
                <>
                  <Path d={fillPath} fill="url(#portfolioFill)" />
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
                        strokeWidth={1.5}
                        x1={activeSelection.x}
                        x2={activeSelection.x}
                        y1={chartPadding}
                        y2={chartHeight - chartPadding}
                      />
                      <Circle
                        cx={activeSelection.x}
                        cy={activeSelection.y}
                        fill={theme.colors.canvasElevated}
                        r={7}
                        stroke={chartAccentColor}
                        strokeWidth={2.5}
                      />
                    </>
                  ) : coordinates.length > 0 ? (
                    <Circle
                      cx={coordinates[coordinates.length - 1]?.x ?? 0}
                      cy={coordinates[coordinates.length - 1]?.y ?? 0}
                      fill={theme.colors.canvasElevated}
                      r={7}
                      stroke={chartAccentColor}
                      strokeWidth={2.5}
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
                      strokeWidth={1.5}
                      x1={activeSelection.x}
                      x2={activeSelection.x}
                      y1={chartPadding}
                      y2={chartHeight - chartPadding}
                    />
                  ) : null}
                </>
              )}
            </Svg>

            <View
              onMoveShouldSetResponder={() => true}
              onResponderGrant={updateActivePoint}
              onResponderMove={updateActivePoint}
              onResponderRelease={releaseActivePoint}
              onResponderTerminate={releaseActivePoint}
              onStartShouldSetResponder={() => true}
              style={styles.chartTouchTarget}
              testID="portfolio-chart-touch-target"
            />
          </>
        ) : null}
      </View>

      <View style={styles.rangeRow}>
        {rangeItems.map((item) => {
          const isSelected = item.value === selectedRange;
          return (
            <Pressable
              accessibilityRole="button"
              key={item.value}
              onPress={() => onRangeChange(item.value as PortfolioHistoryRange)}
              style={({ pressed }) => [
                styles.rangePill,
                isSelected
                  ? { backgroundColor: theme.colors.brand }
                  : null,
                pressed ? { opacity: 0.88 } : null,
              ]}
              testID={`range-${item.value}`}
            >
              <Text
                style={[
                  theme.typography.control,
                  styles.rangePillLabel,
                  {
                    color: isSelected
                      ? theme.colors.textPrimary
                      : theme.colors.textSecondary,
                  },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
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
    flexDirection: 'row',
    gap: 8,
    marginHorizontal: 16,
  },
  rangePill: {
    alignItems: 'center',
    borderRadius: 999,
    flex: 1,
    height: 28,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  rangePillLabel: {
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

import {
  useEffect,
  memo,
  useMemo,
  useState,
} from 'react';
import {
  GestureResponderEvent,
  LayoutChangeEvent,
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
import {
  PillButton,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import {
  formatCompactCurrency,
  formatCurrency,
  formatPercent,
  formatSignedCurrency,
} from './portfolio-formatting';

const chartModeItems = [
  { label: 'Portfolio', value: 'portfolio' },
  { label: 'Sales', value: 'sales' },
] as const;

const rangeItems = [
  { label: '7D', value: '7D' },
  { label: '1M', value: '1M' },
  { label: '3M', value: '3M' },
  { label: '1Y', value: '1Y' },
  { label: 'All', value: 'ALL' },
] as const;

const axisLabelColumnWidth = 56;
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

function formatShortDateLabel(isoDate: string) {
  const date = new Date(normalizeChartPointDate(isoDate));
  if (Number.isNaN(date.valueOf())) {
    return '';
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function buildRoundedCurrencyTicks(values: number[]) {
  const maxValue = Math.max(...values, 0);
  const upperTick = maxValue > 0 ? Number(maxValue.toFixed(2)) : 1;
  const middleTick = Number((upperTick / 2).toFixed(2));

  return [0, middleTick, upperTick];
}

function formatSaleCount(count: number) {
  return `${count} sale${count === 1 ? '' : 's'}`;
}

function formatSalesRangeLabel(
  points: readonly PortfolioDashboard['ranges'][PortfolioHistoryRange]['sales'][number][],
) {
  const startAxisLabel = points[0]?.axisLabel ?? '';
  const endAxisLabel = points[points.length - 1]?.axisLabel ?? '';
  if (startAxisLabel || endAxisLabel) {
    if (!startAxisLabel) {
      return endAxisLabel;
    }

    if (!endAxisLabel || startAxisLabel === endAxisLabel) {
      return startAxisLabel;
    }

    return `${startAxisLabel} - ${endAxisLabel}`;
  }

  const startDate = points[0]?.isoDate ?? '';
  const endDate = points[points.length - 1]?.rangeEndISO ?? points[points.length - 1]?.isoDate ?? '';

  const startLabel = startDate ? formatShortDateLabel(startDate) : '';
  const endLabel = endDate ? formatShortDateLabel(endDate) : '';

  if (!startLabel) {
    return endLabel;
  }

  if (!endLabel || startLabel === endLabel) {
    return startLabel;
  }

  return `${startLabel} - ${endLabel}`;
}

function formatSalesAxisStartLabel(
  point: PortfolioDashboard['ranges'][PortfolioHistoryRange]['sales'][number] | undefined,
) {
  if (!point) {
    return '';
  }

  return point.axisLabel ?? formatShortDateLabel(point.isoDate);
}

function formatSalesAxisEndLabel(
  point: PortfolioDashboard['ranges'][PortfolioHistoryRange]['sales'][number] | undefined,
) {
  if (!point) {
    return '';
  }

  if (point.axisLabel) {
    return point.axisLabel;
  }

  return formatShortDateLabel(point.rangeEndISO ?? point.isoDate);
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

function buildPortfolioSummaryForPoints(
  points: readonly PortfolioDashboard['ranges'][PortfolioHistoryRange]['portfolio'][number][],
  fallback: PortfolioDashboard['summary'],
) {
  const lastPoint = points[points.length - 1];
  const baselinePoint = findPortfolioBaselinePoint(points);

  if (!baselinePoint || !lastPoint) {
    return fallback;
  }

  const changeAmount = Number((lastPoint.value - baselinePoint.value).toFixed(2));
  const changePercent = baselinePoint.value > 0
    ? Number(((changeAmount / baselinePoint.value) * 100).toFixed(2))
    : 0;

  return {
    currentValue: lastPoint.value,
    changeAmount,
    changePercent,
    asOfLabel: lastPoint.shortLabel,
  };
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
  index: number | null,
  fallback: PortfolioDashboard['summary'],
) {
  if (index == null) {
    return {
      amount: fallback.changeAmount,
      percent: fallback.changePercent,
    };
  }

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

function formatSummaryDetailLabel(amount: number, percent: number) {
  return `${formatSignedCurrency(amount)} · ${formatPercent(percent)}`;
}

type PortfolioChartCardProps = {
  chartMode: ChartMode;
  dashboard: PortfolioDashboard;
  selectedRange: PortfolioHistoryRange;
  onModeChange: (value: ChartMode) => void;
  onRangeChange: (value: PortfolioHistoryRange) => void;
};

export const PortfolioChartCard = memo(function PortfolioChartCard({
  chartMode,
  dashboard,
  selectedRange,
  onModeChange,
  onRangeChange,
}: PortfolioChartCardProps) {
  const theme = useSpotlightTheme();
  const [chartWidth, setChartWidth] = useState(0);
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
  const chartHeight = 212;
  const chartPadding = 16;
  const activeRange = dashboard.ranges[selectedRange];
  const series = chartMode === 'portfolio' ? activeRange.portfolio : activeRange.sales;
  const salesPointCounts = useMemo(() => {
    return buildSalesPointCounts(activeRange.sales, dashboard.recentSales);
  }, [activeRange.sales, dashboard.recentSales]);
  const summaryCaption = chartMode === 'portfolio' ? 'PORTFOLIO VALUE' : 'GROSS SALES';
  const chartAccentColor = theme.colors.brand;

  const yAxisValues = useMemo(() => {
    return buildRoundedCurrencyTicks(series.map((point) => point.value));
  }, [series]);
  const yAxisMaxValue = yAxisValues[yAxisValues.length - 1] ?? 1;
  const chartCanvasWidth = Math.max(chartWidth - axisLabelColumnWidth, 1);
  const plotWidth = Math.max(chartCanvasWidth - chartPadding * 2, 1);
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

  const resolvedSalesPointIndex = chartMode === 'sales' ? activePointIndex : null;
  const selectedPoint = chartMode === 'portfolio'
    ? (activePointIndex == null ? null : series[activePointIndex] ?? null)
    : (resolvedSalesPointIndex == null ? null : series[resolvedSalesPointIndex] ?? null);
  const displayPoint = selectedPoint ?? series[series.length - 1] ?? null;
  const portfolioSummary = chartMode === 'portfolio'
    ? buildPortfolioSummaryForPoints(activeRange.portfolio, dashboard.summary)
    : null;
  const totalSalesValue = chartMode === 'sales'
    ? Number(series.reduce((sum, point) => sum + point.value, 0).toFixed(2))
    : 0;
  const displayValue = chartMode === 'portfolio'
    ? (selectedPoint?.value ?? displayPoint?.value ?? portfolioSummary?.currentValue ?? dashboard.summary.currentValue)
    : (selectedPoint?.value ?? totalSalesValue);
  const displayDateLabel = chartMode === 'portfolio'
    ? (displayPoint?.shortLabel ?? portfolioSummary?.asOfLabel ?? dashboard.summary.asOfLabel)
    : (selectedPoint?.shortLabel ?? formatSalesRangeLabel(activeRange.sales));
  const portfolioChange = chartMode === 'portfolio'
    ? portfolioChangeForPoint(series, activePointIndex, portfolioSummary ?? dashboard.summary)
    : null;
  const totalSalesCount = chartMode === 'sales'
    ? salesPointCounts.reduce((sum, count) => sum + count, 0)
    : 0;
  const displaySalesCount = chartMode === 'sales'
    ? (resolvedSalesPointIndex == null
        ? totalSalesCount
        : (salesPointCounts[resolvedSalesPointIndex] ?? 0))
    : 0;
  const summaryDetailLabel = chartMode === 'portfolio'
    ? formatSummaryDetailLabel(
        portfolioChange?.amount ?? portfolioSummary?.changeAmount ?? dashboard.summary.changeAmount,
        portfolioChange?.percent ?? portfolioSummary?.changePercent ?? dashboard.summary.changePercent,
      )
    : (displaySalesCount > 0 ? formatSaleCount(displaySalesCount) : 'No sales');

  const updateActivePoint = (event: GestureResponderEvent) => {
    if (chartWidth === 0 || series.length === 0) {
      return;
    }

    const locationX = clamp(event.nativeEvent.locationX, 0, chartCanvasWidth);
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

  return (
    <SurfaceCard
      padding={16}
      radius={theme.layout.chartCardRadius}
      style={styles.card}
    >
      <View style={styles.cardHeader}>
        <View style={styles.headerCopy}>
          <Text
            style={[
              theme.typography.micro,
              styles.eyebrow,
              {
                color: theme.colors.textSecondary,
              },
            ]}
          >
            {summaryCaption}
          </Text>
        </View>

        <View
          style={[
            styles.toggleWrap,
            {
              backgroundColor: theme.colors.surfaceMuted,
            },
          ]}
        >
          {chartModeItems.map((item) => {
            const selected = item.value === chartMode;

            return (
              <PillButton
                key={item.value}
                label={item.label}
                minWidth={72}
                onPress={() => onModeChange(item.value)}
                selected={selected}
                style={styles.togglePill}
                testID={`chart-mode-${item.value}`}
              />
            );
          })}
        </View>
      </View>

      <View style={styles.valueBlock}>
        <Text style={[theme.typography.display, styles.value]} testID="portfolio-chart-summary-value">
          {formatCurrency(displayValue)}
        </Text>

        {(displayDateLabel || summaryDetailLabel) ? (
          <View style={styles.valueMetaRow}>
            {displayDateLabel ? (
              <Text
                style={[
                  theme.typography.caption,
                  styles.valueMetaDate,
                  { color: theme.colors.textPrimary },
                ]}
                testID="portfolio-chart-summary-date"
              >
                {displayDateLabel}
              </Text>
            ) : null}

            {summaryDetailLabel ? (
              <Text
                style={[
                  theme.typography.caption,
                  styles.valueMetaDetail,
                  { color: theme.colors.textPrimary },
                ]}
                testID="portfolio-chart-summary-detail"
              >
                {summaryDetailLabel}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      <View
        onLayout={onChartLayout}
        style={styles.chartShell}
        testID={`portfolio-chart-${chartMode}`}
      >
        <View style={styles.axisLabelColumn}>
          {yAxisValues
            .slice()
            .reverse()
            .map((value) => {
              return (
                <Text
                  ellipsizeMode="clip"
                  key={value}
                  numberOfLines={1}
                  style={[
                    theme.typography.micro,
                    styles.axisLabel,
                    {
                      color: theme.colors.chartAxisLabel,
                    },
                  ]}
                >
                  {formatCompactCurrency(value)}
                </Text>
              );
            })}
        </View>

        <View style={styles.chartArea}>
          <View pointerEvents="none" style={styles.gridLines}>
            {Array.from({ length: 3 }).map((_, index) => {
              return (
                <View
                  key={index}
                  style={[
                    styles.gridLine,
                    {
                      borderColor: theme.colors.chartGrid,
                    },
                  ]}
                />
              );
            })}
          </View>

          {chartWidth > 0 ? (
            <Svg height={chartHeight} width="100%">
              <Defs>
                <LinearGradient id="portfolioFill" x1="0" x2="0" y1="0" y2="1">
                  <Stop offset="0" stopColor={theme.colors.brand} stopOpacity="0.28" />
                  <Stop offset="1" stopColor={theme.colors.brand} stopOpacity="0.02" />
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
          ) : null}

          <View style={styles.xAxisLabels}>
            <Text
              style={[
                theme.typography.micro,
                {
                  color: theme.colors.chartAxisLabel,
                },
              ]}
            >
              {chartMode === 'sales'
                ? formatSalesAxisStartLabel(series[0])
                : series[0]?.shortLabel}
            </Text>
            <Text
              style={[
                theme.typography.micro,
                {
                  color: theme.colors.chartAxisLabel,
                },
              ]}
            >
              {chartMode === 'sales'
                ? formatSalesAxisEndLabel(series[series.length - 1])
                : series[series.length - 1]?.shortLabel}
            </Text>
          </View>

          <View
            onMoveShouldSetResponder={() => true}
            onResponderGrant={updateActivePoint}
            onResponderMove={updateActivePoint}
            onStartShouldSetResponder={() => true}
            style={styles.chartTouchTarget}
            testID="portfolio-chart-touch-target"
          />
        </View>
      </View>

      <View
        style={[
          styles.rangeRow,
          {
            backgroundColor: theme.colors.surfaceMuted,
          },
        ]}
      >
        {rangeItems.map((item) => {
          return (
            <PillButton
              key={item.value}
              label={item.label}
              onPress={() => onRangeChange(item.value as PortfolioHistoryRange)}
              selected={item.value === selectedRange}
              style={styles.rangePill}
              testID={`range-${item.value}`}
            />
          );
        })}
      </View>
    </SurfaceCard>
  );
});

const styles = StyleSheet.create({
  axisLabel: {
    textAlign: 'left',
  },
  axisLabelColumn: {
    justifyContent: 'space-between',
    paddingBottom: 28,
    paddingRight: 8,
    width: axisLabelColumnWidth,
  },
  card: {
    gap: 12,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  chartArea: {
    flex: 1,
    position: 'relative',
  },
  chartShell: {
    flexDirection: 'row',
    marginTop: 8,
    minHeight: 236,
  },
  chartTouchTarget: {
    ...StyleSheet.absoluteFillObject,
  },
  eyebrow: {
    letterSpacing: 1.2,
  },
  gridLine: {
    borderTopWidth: 1,
    width: '100%',
  },
  gridLines: {
    bottom: 28,
    justifyContent: 'space-between',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 16,
  },
  headerCopy: {
    flex: 1,
  },
  rangePill: {
    alignItems: 'center',
    borderRadius: 999,
    flex: 1,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rangeRow: {
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
    padding: 4,
  },
  toggleWrap: {
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    padding: 4,
  },
  togglePill: {
    flexShrink: 0,
  },
  value: {
    marginTop: 2,
  },
  valueBlock: {
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 4,
  },
  valueMetaDate: {
    textAlign: 'left',
  },
  valueMetaDetail: {
    textAlign: 'left',
  },
  valueMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'flex-start',
  },
  xAxisLabels: {
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    position: 'absolute',
    right: 0,
  },
});

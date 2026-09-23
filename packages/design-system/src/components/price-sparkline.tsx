import { useId } from 'react';
import { View, StyleSheet } from 'react-native';

import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { useSpotlightTheme } from '../theme';
import { colors } from '../tokens';

export type PriceSparklineProps = {
  /** Market-price series, oldest → newest. */
  points: number[];
  /** Percent change across the series; >= 0 tints green, < 0 tints red. */
  trendPct?: number | null;
  width?: number;
  height?: number;
  /**
   * Fill behind the chart while the SVG paints. Defaults to `gray0` (white
   * rows); pass the host surface color when the sparkline sits on a tinted
   * card (e.g. `gray50` inside `TopMoverTile`).
   */
  backgroundColor?: string;
  /**
   * Optional reference price (e.g. the price when a card was watched), drawn
   * as a dashed line and included in the vertical range so it stays in frame.
   */
  baseline?: number | null;
  testID?: string;
};

const DEFAULT_WIDTH = 62;
const DEFAULT_HEIGHT = 22;
// Inset so the stroke does not clip against the SVG edges.
const PADDING_Y = 2;

type Plotted = { x: number; y: number };

type Scale = { min: number; range: number; usableHeight: number };

function scaleFor(values: number[], height: number, baseline?: number | null): Scale {
  const bounded = typeof baseline === 'number' && Number.isFinite(baseline) ? [...values, baseline] : values;
  const min = Math.min(...bounded);
  return {
    min,
    range: Math.max(...bounded) - min,
    usableHeight: Math.max(height - PADDING_Y * 2, 1),
  };
}

function plotPoints(values: number[], width: number, height: number, scale: Scale): Plotted[] {
  if (values.length === 0) {
    return [];
  }

  const { min, range, usableHeight } = scale;

  // Single point or a flat series → draw a centered horizontal line.
  if (values.length === 1 || range === 0) {
    const midY = PADDING_Y + usableHeight / 2;
    const start = values.length === 1 ? [0, width] : values.map((_, index) => (index / (values.length - 1)) * width);
    return start.map((x) => ({ x, y: midY }));
  }

  const step = width / (values.length - 1);
  return values.map((value, index) => ({
    x: index * step,
    // Invert: higher value → smaller y (toward the top).
    y: PADDING_Y + (1 - (value - min) / range) * usableHeight,
  }));
}

function buildLinePath(plotted: Plotted[]) {
  if (plotted.length === 0) {
    return '';
  }

  return plotted
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

function buildAreaPath(plotted: Plotted[], baseline: number) {
  if (plotted.length === 0) {
    return '';
  }

  const last = plotted[plotted.length - 1];
  const first = plotted[0];
  return `${buildLinePath(plotted)} L ${last.x} ${baseline} L ${first.x} ${baseline} Z`;
}

export function PriceSparkline({
  points,
  trendPct,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  backgroundColor = colors.gray0,
  baseline,
  testID,
}: PriceSparklineProps) {
  const theme = useSpotlightTheme();
  const gradientId = useId();

  const scale = points.length > 0 ? scaleFor(points, height, baseline) : null;
  const plotted = scale ? plotPoints(points, width, height, scale) : [];
  const baselineY = scale && typeof baseline === 'number' && Number.isFinite(baseline) && scale.range > 0
    ? PADDING_Y + (1 - (baseline - scale.min) / scale.range) * scale.usableHeight
    : null;
  const isUp = (trendPct ?? 0) >= 0;
  const tint = isUp ? theme.colors.green500 : theme.colors.red500;

  if (plotted.length === 0) {
    return <View style={{ width, height }} testID={testID} />;
  }

  const linePath = buildLinePath(plotted);
  const areaPath = buildAreaPath(plotted, height);

  return (
    <View style={[styles.container, { width, height, backgroundColor }]} testID={testID}>
      <Svg height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <Stop offset="0" stopColor={tint} stopOpacity={0.22} />
            <Stop offset="1" stopColor={tint} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Path d={areaPath} fill={`url(#${gradientId})`} />
        {baselineY !== null ? (
          <Path
            d={`M 0 ${baselineY} L ${width} ${baselineY}`}
            stroke={theme.colors.gray400}
            strokeDasharray="2 2"
            strokeWidth={1}
            testID={testID ? `${testID}-baseline` : undefined}
          />
        ) : null}
        <Path
          d={linePath}
          fill="none"
          stroke={tint}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  // Keep the box reserved even while the SVG paints, so rows stay aligned.
  // The fill itself comes from the `backgroundColor` prop.
  container: {},
});

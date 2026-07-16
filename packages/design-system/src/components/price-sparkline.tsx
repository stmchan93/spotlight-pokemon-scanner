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
  testID?: string;
};

const DEFAULT_WIDTH = 62;
const DEFAULT_HEIGHT = 22;
// Inset so the stroke does not clip against the SVG edges.
const PADDING_Y = 2;

type Plotted = { x: number; y: number };

function plotPoints(values: number[], width: number, height: number): Plotted[] {
  if (values.length === 0) {
    return [];
  }

  const usableHeight = Math.max(height - PADDING_Y * 2, 1);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

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
  testID,
}: PriceSparklineProps) {
  const theme = useSpotlightTheme();
  const gradientId = useId();

  const plotted = plotPoints(points, width, height);
  const isUp = (trendPct ?? 0) >= 0;
  const tint = isUp ? theme.colors.green400 : theme.colors.red400;

  if (plotted.length === 0) {
    return <View style={{ width, height }} testID={testID} />;
  }

  const linePath = buildLinePath(plotted);
  const areaPath = buildAreaPath(plotted, height);

  return (
    <View style={[styles.container, { width, height }]} testID={testID}>
      <Svg height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
        <Defs>
          <LinearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <Stop offset="0" stopColor={tint} stopOpacity={0.22} />
            <Stop offset="1" stopColor={tint} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Path d={areaPath} fill={`url(#${gradientId})`} />
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
  container: {
    // Keep the box reserved even while the SVG paints, so rows stay aligned.
    backgroundColor: colors.gray0,
  },
});

import { type JSX, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, G, Line, LinearGradient, Path, Pattern, Rect, Stop } from 'react-native-svg';

import { useSpotlightTheme } from '@spotlight/design-system';

import { useReduceMotion } from '@/features/scanner/use-reduce-motion';

import {
  MORPH_SAMPLES,
  salesGapThresholdMs,
  areaFillPath,
  baselineSide,
  morphFillPath,
  morphPath,
  nearestIndexByX,
  polylinePath,
  projectPoints,
  resampleSeries,
  samePoints,
  segmentPaths,
  type PriceYScale,
  type SeriesSamples,
} from './price-scrub-chart-geometry';

export type PriceChartPoint = { t: number; v: number };

export type PriceScrubChartProps = {
  points: PriceChartPoint[];
  windowStartMs: number;
  windowEndMs: number;
  variant: 'line' | 'sales';
  color: string;
  height?: number;
  onScrub: (index: number | null) => void;
  /** 'fit' fills the height with the window's own range; default keeps an 8% floor. */
  yScale?: PriceYScale;
  /** Gradient + graph-paper fill under a 'line' series (the portfolio look). */
  areaFill?: boolean;
  /** Faint grid texture over the area fill (Portfolio); off = plain gradient. */
  fillGrid?: boolean;
  testID?: string;
};

const AnimatedPath = Animated.createAnimatedComponent(Path);

const LINE_WIDTH = 2.2;
const SALES_LINE_WIDTH = 2;
const SALES_DOT_RADIUS = 3;
const END_DOT_RADIUS = 4.5;
const MORPH_MS = 420;
const FADE_MS = 350;
const LONG_PRESS_MS = 250;
const FILL_GRID_CELL = 14;
// A horizontal drag past this scrubs at once; a vertical one past the fail
// offset is left to the parent ScrollView.
const DRAG_ACTIVE_OFFSET_X = 6;
const DRAG_FAIL_OFFSET_Y = 10;

type Morph = { from: SeriesSamples; to: SeriesSamples; token: number };

function PriceScrubChartImpl({
  points,
  windowStartMs,
  windowEndMs,
  variant,
  color,
  height = 200,
  onScrub,
  yScale = 'padded',
  areaFill = false,
  fillGrid = true,
  testID = 'price-scrub-chart',
}: PriceScrubChartProps) {
  const theme = useSpotlightTheme();
  const reduceMotion = useReduceMotion();
  const [width, setWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [morph, setMorph] = useState<Morph | null>(null);
  const clipId = `psc${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const isEmpty = points.length < 2;

  const coords = useMemo(
    () => (width > 0 && !isEmpty ? projectPoints(points, windowStartMs, windowEndMs, width, height, yScale) : []),
    [height, isEmpty, points, width, windowEndMs, windowStartMs, yScale],
  );
  const xs = useMemo(() => coords.map((c) => c.x), [coords]);

  const paths = useMemo(() => {
    if (coords.length < 2) {
      return { solid: '', dashed: '' };
    }
    if (variant === 'line') {
      return { solid: polylinePath(coords), dashed: '' };
    }
    return segmentPaths(points, coords, salesGapThresholdMs(windowEndMs - windowStartMs));
  }, [coords, points, variant, windowEndMs, windowStartMs]);

  // --- Range/data change: morph line→line, otherwise fade in. ---
  const morphProgress = useSharedValue(1);
  const fade = useSharedValue(1);
  const prevSamplesRef = useRef<SeriesSamples | null>(null);
  const prevPointsRef = useRef<PriceChartPoint[] | null>(null);
  const morphTokenRef = useRef(0);

  const endMorph = useCallback((token: number) => {
    setMorph((current) => (current && current.token === token ? null : current));
  }, []);

  // Layout effect so the new static path never paints for a frame before the morph starts.
  useLayoutEffect(() => {
    if (width === 0) {
      return;
    }
    const samples = variant === 'line' ? resampleSeries(coords, MORPH_SAMPLES) : null;
    const prevPoints = prevPointsRef.current;
    const prevSamples = prevSamplesRef.current;
    prevPointsRef.current = points;
    prevSamplesRef.current = samples;
    // Width-only changes redraw; only a real data change animates.
    if (prevPoints === null || samePoints(prevPoints, points) || reduceMotion) {
      return;
    }
    if (samples && prevSamples) {
      const token = ++morphTokenRef.current;
      setMorph({ from: prevSamples, to: samples, token });
      morphProgress.value = 0;
      morphProgress.value = withTiming(1, { duration: MORPH_MS, easing: Easing.out(Easing.cubic) }, (finished) => {
        if (finished) {
          runOnJS(endMorph)(token);
        }
      });
      return;
    }
    setMorph(null);
    fade.value = 0;
    fade.value = withTiming(1, { duration: FADE_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- driven by data/geometry; reduceMotion read at change time
  }, [points, coords, variant]);

  const morphFrom = morph?.from;
  const morphTo = morph?.to;
  const morphProps = useAnimatedProps(() => ({
    d: morphFrom && morphTo ? morphPath(morphFrom, morphTo, morphProgress.value) : '',
  }));
  const morphFillProps = useAnimatedProps(() => ({
    d: morphFrom && morphTo ? morphFillPath(morphFrom, morphTo, morphProgress.value, height) : '',
  }));
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  // --- Scrub ---
  const onScrubRef = useRef(onScrub);
  onScrubRef.current = onScrub;
  const activeIndexRef = useRef<number | null>(null);
  const scrubbingRef = useRef(false);
  const lastSideRef = useRef(0);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const variantRef = useRef(variant);
  variantRef.current = variant;

  const handleStart = useCallback(() => {
    scrubbingRef.current = true;
    lastSideRef.current = 0;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  }, []);

  const handleIndex = useCallback((index: number) => {
    const series = pointsRef.current;
    if (!scrubbingRef.current || index < 0 || index >= series.length || index === activeIndexRef.current) {
      return;
    }
    const hadIndex = activeIndexRef.current != null;
    activeIndexRef.current = index;
    const side = baselineSide(series[index].v, series[0].v);
    const crossed = side !== 0 && lastSideRef.current !== 0 && side !== lastSideRef.current;
    if (side !== 0) {
      lastSideRef.current = side;
    }
    if ((variantRef.current === 'sales' && hadIndex) || crossed) {
      void Haptics.selectionAsync().catch(() => {});
    }
    setActiveIndex(index);
    onScrubRef.current(index);
  }, []);

  const handleEnd = useCallback(() => {
    if (!scrubbingRef.current) {
      return;
    }
    scrubbingRef.current = false;
    activeIndexRef.current = null;
    setActiveIndex(null);
    onScrubRef.current(null);
  }, []);

  const lastWorkletIndex = useSharedValue(-1);
  const gesture = useMemo(() => {
    // onEnd only fires for a gesture that actually activated, so the Race loser never releases the scrub.
    const configure = (pan: ReturnType<typeof Gesture.Pan>) =>
      pan
        .onStart((event) => {
          runOnJS(handleStart)();
          const index = nearestIndexByX(xs, event.x);
          lastWorkletIndex.value = index;
          runOnJS(handleIndex)(index);
        })
        .onUpdate((event) => {
          const index = nearestIndexByX(xs, event.x);
          if (index !== lastWorkletIndex.value) {
            lastWorkletIndex.value = index;
            runOnJS(handleIndex)(index);
          }
        })
        .onEnd(() => {
          lastWorkletIndex.value = -1;
          runOnJS(handleEnd)();
        });
    const drag = configure(
      Gesture.Pan()
        .withTestId(`${testID}-drag`)
        .activeOffsetX([-DRAG_ACTIVE_OFFSET_X, DRAG_ACTIVE_OFFSET_X])
        .failOffsetY([-DRAG_FAIL_OFFSET_Y, DRAG_FAIL_OFFSET_Y]),
    );
    const hold = configure(Gesture.Pan().withTestId(`${testID}-hold`).activateAfterLongPress(LONG_PRESS_MS));
    return Gesture.Race(drag, hold);
  }, [handleEnd, handleIndex, handleStart, lastWorkletIndex, testID, xs]);

  // A data swap or unmount mid-scrub must not strand the parent on a stale index.
  useEffect(() => {
    if (activeIndexRef.current != null && activeIndexRef.current >= points.length) {
      handleEnd();
    }
  }, [handleEnd, points]);
  useEffect(() => () => {
    if (scrubbingRef.current) {
      onScrubRef.current(null);
    }
  }, []);

  const onLayout = (event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  };

  const dotElements = useMemo(() => {
    if (variant !== 'sales') {
      return null;
    }
    return coords.map((c, index) => <Circle cx={c.x} cy={c.y} key={index} r={SALES_DOT_RADIUS} />);
  }, [coords, variant]);

  if (isEmpty) {
    return <View style={{ height }} testID={`${testID}-empty`} />;
  }

  const active = activeIndex != null ? coords[activeIndex] : undefined;
  const dot = active ?? coords[coords.length - 1];
  const clipWidth = active ? active.x + 10 : width + 20;
  const dimColor = theme.colors.gray200;
  const strokeWidth = variant === 'line' ? LINE_WIDTH : SALES_LINE_WIDTH;

  const showFill = areaFill;
  // Sales paths are split at gaps, so fill under one continuous polyline instead.
  const fillLine = variant === 'line' ? paths.solid : coords.length >= 2 ? polylinePath(coords) : '';
  // Closed under the first and last points, never at the chart's corners.
  const fillD = showFill && coords.length >= 2
    ? areaFillPath(fillLine, coords[0].x, coords[coords.length - 1].x, height)
    : '';
  const fillIds = { gradient: `${clipId}fill`, grid: `${clipId}grid` };
  const renderFill = () => (morph ? (
    <>
      <AnimatedPath animatedProps={morphFillProps} fill={`url(#${fillIds.gradient})`} />
      {fillGrid ? <AnimatedPath animatedProps={morphFillProps} fill={`url(#${fillIds.grid})`} /> : null}
    </>
  ) : fillD ? (
    <>
      <Path d={fillD} fill={`url(#${fillIds.gradient})`} testID={fillGrid ? undefined : `${testID}-fill`} />
      {fillGrid ? <Path d={fillD} fill={`url(#${fillIds.grid})`} testID={`${testID}-fill`} /> : null}
    </>
  ) : null);

  const renderSeries = (stroke: string) => (
    <>
      {morph ? (
        <AnimatedPath animatedProps={morphProps} fill="none" stroke={stroke} strokeWidth={strokeWidth} />
      ) : paths.solid ? (
        <Path d={paths.solid} fill="none" stroke={stroke} strokeWidth={strokeWidth} />
      ) : null}
      {paths.dashed ? (
        <Path d={paths.dashed} fill="none" stroke={stroke} strokeDasharray={[3, 5]} strokeWidth={SALES_LINE_WIDTH} />
      ) : null}
      {dotElements ? <G fill={stroke} stroke="none">{dotElements}</G> : null}
    </>
  );

  return (
    <View onLayout={onLayout} style={[styles.root, { height }]} testID={testID}>
      {width > 0 && coords.length >= 2 ? (
        <GestureDetector gesture={gesture}>
          <Animated.View style={[StyleSheet.absoluteFill, fadeStyle]} testID={`${testID}-canvas`}>
            {/* Numeric width: "100%" on the Svg root renders zero-width on Android. */}
            <Svg height={height} width={width}>
              <Defs>
                <ClipPath id={clipId}>
                  <Rect height={height} testID={`${testID}-clip`} width={clipWidth} x={-10} y={0} />
                </ClipPath>
                {showFill ? (
                  <>
                    <LinearGradient id={fillIds.gradient} x1="0" x2="0" y1="0" y2="1">
                      <Stop offset="0" stopColor={color} stopOpacity="0.35" />
                      <Stop offset="1" stopColor={color} stopOpacity="0" />
                    </LinearGradient>
                    <Pattern height={FILL_GRID_CELL} id={fillIds.grid} patternUnits="userSpaceOnUse" width={FILL_GRID_CELL}>
                      <Path
                        d={`M${FILL_GRID_CELL} 0 L0 0 L0 ${FILL_GRID_CELL}`}
                        fill="none"
                        stroke={color}
                        strokeOpacity={0.16}
                        strokeWidth={0.75}
                      />
                    </Pattern>
                  </>
                ) : null}
              </Defs>
              {showFill ? <G clipPath={`url(#${clipId})`}>{renderFill()}</G> : null}
              <G strokeLinecap="round" strokeLinejoin="round">
                {renderSeries(dimColor)}
              </G>
              <G clipPath={`url(#${clipId})`} strokeLinecap="round" strokeLinejoin="round">
                {renderSeries(color)}
              </G>
              {active ? (
                <Line
                  stroke={theme.colors.gray300}
                  strokeWidth={1}
                  testID={`${testID}-cursor`}
                  x1={active.x}
                  x2={active.x}
                  y1={0}
                  y2={height}
                />
              ) : null}
              {dot ? (
                <Circle
                  cx={dot.x}
                  cy={dot.y}
                  fill={color}
                  r={END_DOT_RADIUS}
                  stroke={theme.colors.gray0}
                  strokeWidth={1.5}
                  testID={`${testID}-dot`}
                />
              ) : null}
            </Svg>
          </Animated.View>
        </GestureDetector>
      ) : null}
    </View>
  );
}

export const PriceScrubChart = memo(PriceScrubChartImpl) as (props: PriceScrubChartProps) => JSX.Element;

const styles = StyleSheet.create({
  root: {
    position: 'relative',
    width: '100%',
  },
});

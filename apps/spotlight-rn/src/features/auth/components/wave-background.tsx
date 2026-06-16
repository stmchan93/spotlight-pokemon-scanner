import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { useSpotlightTheme } from '@spotlight/design-system';

type WaveBackgroundProps = {
  /** Height of the wave band; it sits on pure black, matching the auth screen. */
  height: number;
  testID?: string;
};

type WaveLayer = {
  amplitude: number;
  /** Vertical center of the wave as a fraction of the band height. */
  midRatio: number;
  wavelength: number;
  durationMs: number;
  opacity: number;
  color: string;
  kind: 'fill' | 'line';
  strokeWidth: number;
};

const POINT_STEP = 8;

function buildWavePath(opts: {
  spanWidth: number;
  height: number;
  amplitude: number;
  midY: number;
  wavelength: number;
  phase: number;
  fill: boolean;
}): string {
  const { spanWidth, height, amplitude, midY, wavelength, phase, fill } = opts;
  let d = '';
  for (let x = 0; x <= spanWidth; x += POINT_STEP) {
    const y = midY + amplitude * Math.sin((x / wavelength) * Math.PI * 2 + phase);
    d += x === 0 ? `M ${x} ${y.toFixed(2)}` : ` L ${x} ${y.toFixed(2)}`;
  }
  if (fill) {
    d += ` L ${spanWidth} ${height} L 0 ${height} Z`;
  }
  return d;
}

/**
 * The flowing wave hero shown behind the top of every auth screen
 * (Figma 1481:4380), rendered NATIVELY with react-native-svg + Reanimated —
 * no WebView. A few translucent sine layers (brand + white) drift horizontally
 * at different speeds on pure black; because each layer is exactly periodic and
 * scrolls by one wavelength on a linear loop, the motion never seams or repeats
 * visibly. The horizontal drift runs on the UI thread (transform only), so it is
 * cheap and smooth, and ships over OTA. Non-interactive — taps pass through.
 */
export function WaveBackground({ height, testID }: WaveBackgroundProps) {
  const theme = useSpotlightTheme();
  const { width } = useWindowDimensions();

  // null = unresolved; hold the waves static until we know the preference.
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => !cancelled && setReduceMotion(value))
      .catch(() => !cancelled && setReduceMotion(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const layers = useMemo<WaveLayer[]>(
    () => [
      { amplitude: 24, midRatio: 0.54, wavelength: 340, durationMs: 11000, opacity: 0.12, color: theme.colors.brand, kind: 'fill', strokeWidth: 0 },
      { amplitude: 18, midRatio: 0.64, wavelength: 250, durationMs: 14000, opacity: 0.07, color: '#FFFFFF', kind: 'fill', strokeWidth: 0 },
      { amplitude: 22, midRatio: 0.48, wavelength: 300, durationMs: 8000, opacity: 0.55, color: '#FFFFFF', kind: 'line', strokeWidth: 1.5 },
      { amplitude: 15, midRatio: 0.6, wavelength: 210, durationMs: 17000, opacity: 0.4, color: theme.colors.brand, kind: 'line', strokeWidth: 1.5 },
    ],
    [theme.colors.brand],
  );

  return (
    <View pointerEvents="none" style={[styles.root, { height }]} testID={testID}>
      {layers.map((layer, index) => (
        <WaveLayerView
          animate={reduceMotion === false}
          height={height}
          key={index}
          layer={layer}
          phase={index * 1.27}
          screenWidth={width}
        />
      ))}
    </View>
  );
}

function WaveLayerView({
  animate,
  height,
  layer,
  phase,
  screenWidth,
}: {
  animate: boolean;
  height: number;
  layer: WaveLayer;
  phase: number;
  screenWidth: number;
}) {
  // Span one extra wavelength so the right edge always covers the screen as the
  // layer scrolls left by up to one wavelength.
  const spanWidth = screenWidth + layer.wavelength;
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!animate) {
      progress.value = 0;
      return;
    }
    progress.value = withRepeat(
      withTiming(1, { duration: layer.durationMs, easing: Easing.linear }),
      -1,
      false,
    );
  }, [animate, layer.durationMs, progress]);

  // Scroll by exactly one wavelength — the wave is periodic there, so the loop's
  // reset is seamless (no visible jump).
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -progress.value * layer.wavelength }],
  }));

  const d = useMemo(
    () =>
      buildWavePath({
        spanWidth,
        height,
        amplitude: layer.amplitude,
        midY: height * layer.midRatio,
        wavelength: layer.wavelength,
        phase,
        fill: layer.kind === 'fill',
      }),
    [height, layer, phase, spanWidth],
  );

  return (
    <Animated.View style={[styles.layer, { width: spanWidth }, animatedStyle]}>
      <Svg height={height} width={spanWidth}>
        {layer.kind === 'fill' ? (
          <Path d={d} fill={layer.color} fillOpacity={layer.opacity} />
        ) : (
          <Path
            d={d}
            fill="none"
            stroke={layer.color}
            strokeOpacity={layer.opacity}
            strokeWidth={layer.strokeWidth}
          />
        )}
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#000000',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  layer: {
    ...StyleSheet.absoluteFillObject,
  },
});

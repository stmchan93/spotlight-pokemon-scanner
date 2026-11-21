import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';
import { radii } from '../tokens';

export type ProgressBarSize = 'sm' | 'md' | 'lg';
export type ProgressBarTrack = 'neutral' | 'accent';
export type ProgressBarTone = 'accent' | 'neutral';

type ProgressBarProps = {
  /** Fraction complete, 0..1. Out-of-range and non-finite values are clamped (NaN → 0). */
  value: number;
  /**
   * 'md' (default) is the 6pt "Collection Progress" bar (Figma 6552:1961); 'sm'
   * is 4pt; 'lg' is the set page header's 20pt bar at radius 8 (6607:8644).
   */
  size?: ProgressBarSize;
  /** Track color: 'neutral' (default) = gray200, 'accent' = purple100. */
  track?: ProgressBarTrack;
  /** Fill color: 'accent' (default) = purple500, 'neutral' = gray900. */
  tone?: ProgressBarTone;
  /**
   * Text centred in the bar ("45%", Figma 6607:8860). Use with size 'lg'. Drawn
   * two-tone: gray900 over the track, white over the fill, split exactly at the
   * fill edge so every glyph keeps contrast at any value.
   */
  label?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const HEIGHTS: Record<ProgressBarSize, number> = {
  sm: 4,
  md: 6,
  lg: 20,
};

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return value === Infinity ? 1 : 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * A horizontal completion bar: a rounded gray track with a rounded fill whose
 * width is `value` of the track. Set completion on the sets list and set page.
 */
export function ProgressBar({
  value,
  size = 'md',
  tone = 'accent',
  track = 'neutral',
  label,
  accessibilityLabel,
  style,
  testID,
}: ProgressBarProps) {
  const theme = useSpotlightTheme();
  const [trackWidth, setTrackWidth] = useState(0);
  const fraction = clampProgress(value);
  const height = HEIGHTS[size];
  const fillColor = tone === 'neutral' ? theme.colors.gray900 : theme.colors.purple500;
  const trackColor = track === 'accent' ? theme.colors.purple100 : theme.colors.gray200;
  // The 20pt bar squares off to radius 8; thinner bars stay full pills.
  const radius = size === 'lg' ? radii.sm : radii.pill;
  const hasLabel = Boolean(label);

  const onLayout = hasLabel
    ? (event: LayoutChangeEvent) => setTrackWidth(event.nativeEvent.layout.width)
    : undefined;

  const labelText = (color: string, labelTestID?: string) => (
    <Text
      numberOfLines={1}
      style={[theme.typography.overlineMedium, { color }]}
      testID={labelTestID}
    >
      {label}
    </Text>
  );

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="progressbar"
      accessibilityValue={{ max: 100, min: 0, now: Math.round(fraction * 100) }}
      onLayout={onLayout}
      style={[styles.track, { backgroundColor: trackColor, borderRadius: radius, height }, style]}
      testID={testID}
    >
      {/* Dark copy sits under the opaque fill, so it only shows over the track. */}
      {hasLabel ? (
        <View pointerEvents="none" style={styles.labelBox}>
          {labelText(theme.colors.gray900, testID ? `${testID}-label` : undefined)}
        </View>
      ) : null}
      <View
        style={[
          styles.fill,
          { backgroundColor: fillColor, borderRadius: radius, width: `${fraction * 100}%` },
        ]}
        testID={testID ? `${testID}-fill` : undefined}
      >
        {/* White copy laid out at the full track width, clipped by the fill. */}
        {hasLabel && trackWidth > 0 ? (
          <View pointerEvents="none" style={[styles.labelOnFill, { width: trackWidth }]}>
            {labelText(theme.colors.gray0, testID ? `${testID}-label-on-fill` : undefined)}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: '100%',
    overflow: 'hidden',
  },
  labelBox: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelOnFill: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    top: 0,
  },
  track: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    overflow: 'hidden',
    width: '100%',
  },
});

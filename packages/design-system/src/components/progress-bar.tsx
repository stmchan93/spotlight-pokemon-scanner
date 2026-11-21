import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

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
  accessibilityLabel,
  style,
  testID,
}: ProgressBarProps) {
  const theme = useSpotlightTheme();
  const fraction = clampProgress(value);
  const height = HEIGHTS[size];
  const fillColor = tone === 'neutral' ? theme.colors.gray900 : theme.colors.purple500;
  const trackColor = track === 'accent' ? theme.colors.purple100 : theme.colors.gray200;
  // The 20pt bar squares off to radius 8; thinner bars stay full pills.
  const radius = size === 'lg' ? radii.sm : radii.pill;

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="progressbar"
      accessibilityValue={{ max: 100, min: 0, now: Math.round(fraction * 100) }}
      style={[styles.track, { backgroundColor: trackColor, borderRadius: radius, height }, style]}
      testID={testID}
    >
      <View
        style={[
          styles.fill,
          { backgroundColor: fillColor, borderRadius: radius, width: `${fraction * 100}%` },
        ]}
        testID={testID ? `${testID}-fill` : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: '100%',
  },
  track: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    overflow: 'hidden',
    width: '100%',
  },
});

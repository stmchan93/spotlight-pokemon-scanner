import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';
import { radii, spacing } from '../tokens';

export type PricePositionBarSize = 'sm' | 'md';

type PricePositionBarProps = {
  /** Where the current price sits between the range's low (0) and high (100). Clamped. */
  percentile: number;
  /** Overrides the thirds label ("Near its recent low" on the Bargain board). */
  label?: string;
  /** Right of the label (md only), e.g. the server's window label "Past 3 months". */
  detail?: string;
  /** Formatted low / high prices under the track ends (md only). */
  lowLabel?: string;
  highLabel?: string;
  /** 'md' (default): label row + 6pt track + end prices. 'sm': label + 4pt track (rail tiles). */
  size?: PricePositionBarSize;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const METRICS: Record<PricePositionBarSize, { track: number; marker: number; ring: number }> = {
  sm: { track: 4, marker: 10, ring: 2 },
  md: { track: 6, marker: 14, ring: 2 },
};

export function clampPercentile(percentile: number): number {
  return Number.isFinite(percentile) ? Math.min(100, Math.max(0, percentile)) : 50;
}

/**
 * Plain-language read of a percentile by thirds. Describes where the price IS
 * against its own recent range — never where it is going.
 */
export function pricePositionLabel(percentile: number): string {
  const value = clampPercentile(percentile);
  if (value < 100 / 3) {
    return 'Cheaper than usual';
  }
  if (value < 200 / 3) {
    return 'Mid-range';
  }
  return 'Pricier than usual';
}

/**
 * "Cheap or pricey": a low ↔ high track with a marker at today's price and a
 * short label. Used on the PDP under the price and on the Market Analytics
 * Bargain board. Neutral colors on purpose — position is context, not a signal.
 */
export function PricePositionBar({
  percentile,
  label,
  detail,
  lowLabel,
  highLabel,
  size = 'md',
  style,
  testID = 'price-position-bar',
}: PricePositionBarProps) {
  const theme = useSpotlightTheme();
  const metrics = METRICS[size];
  const value = clampPercentile(percentile);
  const text = label ?? pricePositionLabel(value);
  const showEnds = size === 'md' && (lowLabel || highLabel);
  const accessibilityLabel = [
    text,
    lowLabel ? `Low ${lowLabel}` : null,
    highLabel ? `High ${highLabel}` : null,
    detail ?? null,
  ].filter(Boolean).join('. ');

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="text"
      accessible
      style={[styles.root, size === 'sm' ? styles.rootSm : null, style]}
      testID={testID}
    >
      <View style={styles.labelRow}>
        <Text
          numberOfLines={1}
          style={[
            size === 'md' ? theme.typography.captionMedium : theme.typography.overline,
            styles.label,
            { color: theme.colors.gray900 },
          ]}
          testID={`${testID}-label`}
        >
          {text}
        </Text>
        {detail && size === 'md' ? (
          <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]} testID={`${testID}-detail`}>
            {detail}
          </Text>
        ) : null}
      </View>
      {/* The marker rides a rail inset by half a dot, so it stays on the track at 0 and 100. */}
      <View style={{ height: Math.max(metrics.track, metrics.marker), justifyContent: 'center' }}>
        <View
          style={{
            backgroundColor: theme.colors.gray200,
            borderCurve: 'continuous',
            borderRadius: radii.pill,
            height: metrics.track,
          }}
          testID={`${testID}-track`}
        />
        <View style={[styles.rail, { left: metrics.marker / 2, right: metrics.marker / 2 }]}>
          <View
            style={[
              styles.marker,
              {
                backgroundColor: theme.colors.purple500,
                borderColor: theme.colors.gray0,
                borderCurve: 'continuous',
                borderRadius: radii.pill,
                borderWidth: metrics.ring,
                height: metrics.marker,
                left: `${value}%`,
                marginLeft: -metrics.marker / 2,
                width: metrics.marker,
              },
            ]}
            testID={`${testID}-marker`}
          />
        </View>
      </View>
      {showEnds ? (
        <View style={styles.endsRow}>
          <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]} testID={`${testID}-low`}>
            {lowLabel ?? ''}
          </Text>
          <Text style={[theme.typography.overline, { color: theme.colors.gray600 }]} testID={`${testID}-high`}>
            {highLabel ?? ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  endsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  label: {
    flexShrink: 1,
  },
  labelRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: spacing.xxs,
    justifyContent: 'space-between',
  },
  marker: {
    position: 'absolute',
    top: 0,
  },
  rail: {
    bottom: 0,
    position: 'absolute',
    top: 0,
  },
  root: {
    gap: spacing.xxs,
  },
  rootSm: {
    gap: 6,
  },
});

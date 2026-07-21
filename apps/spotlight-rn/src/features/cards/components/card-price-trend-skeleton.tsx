import { useEffect, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { SkeletonBlock, Text, useSpotlightTheme } from '@spotlight/design-system';

type CardPriceTrendSkeletonProps = {
  /** Number of placeholder rows to render (matches the trend list density). */
  rowCount?: number;
  testID?: string;
};

/**
 * Loading placeholder for the price-trend section. Renders the section title
 * plus a few gray rows so the slot reads "loading" instead of collapsing to
 * nothing while the (parallel) trend fetch is in flight. A subtle opacity pulse
 * drives liveness, suppressed under reduce-motion.
 */
export function CardPriceTrendSkeleton({
  rowCount = 4,
  testID,
}: CardPriceTrendSkeletonProps) {
  const theme = useSpotlightTheme();

  // null = not yet resolved; gate the pulse on a known preference.
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const pulse = useSharedValue(1);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (!cancelled) {
          setReduceMotion(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReduceMotion(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (reduceMotion !== false) {
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withTiming(0.5, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse, reduceMotion]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View style={[styles.root, { gap: 10 }]} testID={testID}>
      <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
        Price Trend
      </Text>
      <Animated.View style={[styles.rows, pulseStyle]}>
        {Array.from({ length: rowCount }, (_, index) => (
          <View key={index} style={styles.row}>
            <SkeletonBlock height={14} radius={theme.radii.sm} width="40%" />
            <SkeletonBlock height={14} radius={theme.radii.sm} width={64} />
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 28,
    justifyContent: 'space-between',
  },
  rows: {
    gap: 12,
    width: '100%',
  },
});

export default CardPriceTrendSkeleton;

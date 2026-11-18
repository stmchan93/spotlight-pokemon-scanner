import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { Text, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { useReduceMotion } from '@/features/scanner/use-reduce-motion';

const DOT_SIZE = 6;
const PULSE_MS = 360;
const STAGGER_MS = 160;
const REST_OPACITY = 0.3;

function Dot({ progress, color }: { progress: SharedValue<number>; color: string }) {
  const style = useAnimatedStyle(() => ({
    opacity: REST_OPACITY + (1 - REST_OPACITY) * progress.value,
    transform: [{ translateY: -progress.value * 2 }],
  }));
  return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
}

/** The assistant's "typing" row: three pulsing dots and a short status line. Static under Reduce Motion. */
export function AssistantThinkingIndicator({ label, testID }: { label: string; testID?: string }) {
  const theme = useSpotlightTheme();
  const reduceMotion = useReduceMotion();
  const first = useSharedValue(0);
  const second = useSharedValue(0);
  const third = useSharedValue(0);

  useEffect(() => {
    const dots = [first, second, third];
    if (reduceMotion) {
      dots.forEach((dot) => {
        cancelAnimation(dot);
        dot.value = 1;
      });
      return undefined;
    }
    dots.forEach((dot, index) => {
      dot.value = withDelay(
        index * STAGGER_MS,
        withRepeat(
          withSequence(withTiming(1, { duration: PULSE_MS }), withTiming(0, { duration: PULSE_MS })),
          -1,
        ),
      );
    });
    return () => dots.forEach((dot) => cancelAnimation(dot));
  }, [first, reduceMotion, second, third]);

  return (
    <View
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      accessible
      style={styles.row}
      testID={testID}
    >
      <View style={styles.dots}>
        {[first, second, third].map((dot, index) => (
          <Dot color={theme.colors.gray500} key={index} progress={dot} />
        ))}
      </View>
      <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: spacing.xxs,
    paddingVertical: spacing.xxxs,
  },
  dots: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  dot: {
    borderCurve: 'continuous',
    borderRadius: DOT_SIZE / 2,
    height: DOT_SIZE,
    width: DOT_SIZE,
  },
});

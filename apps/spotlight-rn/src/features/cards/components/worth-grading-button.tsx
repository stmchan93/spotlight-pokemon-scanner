import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { Text, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { EkalightAiSparkle } from '@/components/ekalight-ai-glyph';

// Same height as the configurator's option chips, so it sits on their line.
const PILL_HEIGHT = 32;
const SPARKLE_SIZE = 16;
const RING_STROKE = 1.5;

type WorthGradingButtonProps = {
  onPress: () => void;
  testID?: string;
};

/** "✦ Worth grading?": the PDP's AI entry point, a purple-ringed pill. */
export function WorthGradingButton({ onPress, testID = 'worth-grading-button' }: WorthGradingButtonProps) {
  const theme = useSpotlightTheme();
  const [width, setWidth] = useState(0);
  const radius = PILL_HEIGHT / 2;

  return (
    <Pressable
      accessibilityHint="Opens an Ekalight analysis of whether grading this card pays off."
      accessibilityLabel="Worth grading?"
      accessibilityRole="button"
      hitSlop={6}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: theme.colors.purple50,
          borderCurve: 'continuous',
          borderRadius: radius,
          // Purple glow is iOS-only; Android's elevation shadow can't be
          // tinted, so it gets the gradient ring alone.
          shadowColor: theme.colors.purple500,
          opacity: pressed ? 0.84 : 1,
        },
      ]}
      testID={testID}
    >
      {width > 0 ? (
        <Svg height={PILL_HEIGHT} pointerEvents="none" style={StyleSheet.absoluteFill} width={width}>
          <Defs>
            <LinearGradient id="worthGradingRing" x1="0" x2="1" y1="0" y2="0">
              <Stop offset="0" stopColor={theme.colors.purple300} />
              <Stop offset="1" stopColor={theme.colors.purple500} />
            </LinearGradient>
          </Defs>
          <Rect
            fill="none"
            height={PILL_HEIGHT - RING_STROKE}
            rx={(PILL_HEIGHT - RING_STROKE) / 2}
            stroke="url(#worthGradingRing)"
            strokeWidth={RING_STROKE}
            width={width - RING_STROKE}
            x={RING_STROKE / 2}
            y={RING_STROKE / 2}
          />
        </Svg>
      ) : null}
      <View style={styles.content}>
        <EkalightAiSparkle size={SPARKLE_SIZE} />
        <Text numberOfLines={1} style={[theme.typography.bodyMedium, { color: theme.colors.brandStrong }]}>
          Worth grading?
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  pill: {
    alignItems: 'center',
    height: PILL_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.28,
    shadowRadius: 8,
  },
});

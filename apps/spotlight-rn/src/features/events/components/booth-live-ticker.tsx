import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';

import { radii, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import type { BoothTickerItem } from '@/features/events/booth-ticker';
import { useReduceMotion } from '@/features/scanner/use-reduce-motion';

export const TICKER_ROTATE_MS = 4_000;
const TICKER_HEIGHT = 40;
const LIVE_DOT_SIZE = 8;
const SLIDE_MS = 280;

type BoothLiveTickerProps = {
  items: readonly BoothTickerItem[];
  /** Vendor lines select their vendor on the map. */
  onSelectVendor: (vendorId: string) => void;
};

/** One live line at a time, rotating. Renders nothing without items. */
export function BoothLiveTicker({ items, onSelectVendor }: BoothLiveTickerProps) {
  const theme = useSpotlightTheme();
  const reduceMotion = useReduceMotion();
  const [index, setIndex] = useState(0);
  const count = items.length;

  // Restarts when the list length changes (a 60s refresh), not on every new array.
  useEffect(() => {
    if (count < 2) {
      return undefined;
    }
    const timer = setInterval(() => setIndex((current) => (current + 1) % count), TICKER_ROTATE_MS);
    return () => clearInterval(timer);
  }, [count]);

  if (count === 0) {
    return null;
  }
  const item = items[index % count];
  const vendorId = item.vendorId;
  return (
    <Pressable
      accessibilityLabel={item.text}
      accessibilityRole={vendorId ? 'button' : 'text'}
      disabled={!vendorId}
      onPress={vendorId ? () => onSelectVendor(vendorId) : undefined}
      style={[styles.ticker, { backgroundColor: theme.colors.gray100 }]}
      testID="booth-live-ticker"
    >
      <View style={[styles.dot, { backgroundColor: theme.colors.red500 }]} />
      <View style={styles.window}>
        {/* Keyed by item: the old line slides out as the new one slides in; reduced motion just swaps. */}
        <Animated.View
          entering={reduceMotion ? undefined : FadeInDown.duration(SLIDE_MS)}
          exiting={reduceMotion ? undefined : FadeOutUp.duration(SLIDE_MS)}
          key={item.key}
          style={styles.line}
        >
          <Text
            numberOfLines={1}
            style={[theme.typography.label, { color: theme.colors.gray900 }]}
            testID="booth-live-ticker-text"
          >
            {item.text}
          </Text>
        </Animated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  ticker: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: spacing.xxs,
    height: TICKER_HEIGHT,
    paddingHorizontal: spacing.xs,
  },
  dot: {
    borderCurve: 'continuous',
    borderRadius: LIVE_DOT_SIZE / 2,
    height: LIVE_DOT_SIZE,
    width: LIVE_DOT_SIZE,
  },
  // Clips the slide so outgoing and incoming lines overlap in one row.
  window: {
    alignSelf: 'stretch',
    flex: 1,
    overflow: 'hidden',
  },
  line: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
  },
});

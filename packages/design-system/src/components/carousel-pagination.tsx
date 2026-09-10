import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { useSpotlightTheme } from '../theme';

/**
 * Carousel position indicator (Figma 5085:15541 "Slider container").
 *
 * The active slide is a 24x6 track with a fill that GROWS ACROSS IT while the
 * slide dwells; every other slide is a 6pt dot. Figma draws the fill at 18 of
 * 24 — three quarters of the way through the dwell — which is what says the
 * bar is a countdown to the next slide and not merely a wider dot.
 *
 * The fill is therefore only meaningful next to an auto-advancing carousel.
 * With `dwellMs` at 0 (a static rail, a screenshot, a test) it sits SOLID, so
 * the indicator degrades to the ordinary pill-and-dots shape rather than to a
 * bar frozen part-filled, which would read as a stalled load.
 */

/** Dot diameter, and the height of the whole indicator. */
const DOT_SIZE = 6;
/** Width of the active slide's track. */
const ACTIVE_WIDTH = 24;
/** Space between dots (Figma: dots start every 10pt, so 6 + 4). */
const GAP = 4;

/** Width of the indicator for `count` slides, for callers reserving space. */
export function carouselPaginationWidth(count: number): number {
  if (count < 2) {
    return 0;
  }
  return ACTIVE_WIDTH + (count - 1) * (DOT_SIZE + GAP) + GAP;
}

export type CarouselPaginationProps = {
  /** Number of slides. Under 2 the indicator renders nothing — one slide has no position to report. */
  count: number;
  activeIndex: number;
  /**
   * How long the active slide dwells before the carousel advances itself, in
   * ms. Drives the fill's sweep; 0 (the default) leaves the fill solid.
   */
  dwellMs?: number;
  testID?: string;
};

export function CarouselPagination({
  count,
  activeIndex,
  dwellMs = 0,
  testID,
}: CarouselPaginationProps) {
  const theme = useSpotlightTheme();
  // 0 → empty track, 1 → filled. Native-driven: it is a transform, so the
  // sweep never competes with the feed's own scrolling on the JS thread.
  const progress = useRef(new Animated.Value(dwellMs ? 0 : 1)).current;

  useEffect(() => {
    if (!dwellMs) {
      progress.setValue(1);
      return undefined;
    }
    // Restart on every settle — a hand swipe resets the countdown exactly as
    // the rail's own timer treats it.
    progress.setValue(0);
    const sweep = Animated.timing(progress, {
      duration: dwellMs,
      easing: Easing.linear,
      toValue: 1,
      useNativeDriver: true,
    });
    sweep.start();
    return () => sweep.stop();
  }, [activeIndex, dwellMs, progress]);

  if (count < 2) {
    return null;
  }

  return (
    <View style={styles.row} testID={testID}>
      {Array.from({ length: count }, (_, index) => {
        const isActive = index === activeIndex;
        if (!isActive) {
          return (
            <View
              key={index}
              style={[styles.dot, { backgroundColor: theme.colors.gray200 }]}
              testID={testID ? `${testID}-dot-${index}` : undefined}
            />
          );
        }
        return (
          <View
            key={index}
            style={[styles.track, { backgroundColor: theme.colors.gray200 }]}
            testID={testID ? `${testID}-active-${index}` : undefined}
          >
            <Animated.View
              style={[
                styles.fill,
                {
                  backgroundColor: theme.colors.gray500,
                  transform: [{ scaleX: progress }],
                },
              ]}
              testID={testID ? `${testID}-fill` : undefined}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    borderCurve: 'continuous',
    borderRadius: DOT_SIZE / 2,
    height: DOT_SIZE,
    width: DOT_SIZE,
  },
  fill: {
    borderCurve: 'continuous',
    borderRadius: DOT_SIZE / 2,
    height: DOT_SIZE,
    // Anchored left so the scale reads as a fill sweeping across the track
    // rather than one growing out of its middle.
    transformOrigin: 'left',
    width: ACTIVE_WIDTH,
  },
  row: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: GAP,
  },
  track: {
    borderCurve: 'continuous',
    borderRadius: DOT_SIZE / 2,
    height: DOT_SIZE,
    overflow: 'hidden',
    width: ACTIVE_WIDTH,
  },
});

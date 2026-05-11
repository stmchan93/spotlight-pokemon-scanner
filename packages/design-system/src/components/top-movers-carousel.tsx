import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';
import { SkeletonBlock } from './skeleton-block';

export type TopMoversCarouselItem = {
  id: string;
  imageUrl: string | null;
  /** Card name + optional `(#123/456)`-style trailing label rendered in one line. */
  title: string;
  /** Pre-formatted change label (e.g. "+3.20%"). Color is derived from direction. */
  changeLabel: string;
  direction?: 'up' | 'down';
};

export type TopMoversCarouselProps = {
  items: TopMoversCarouselItem[];
  onItemPress?: (itemId: string) => void;
  /** Auto-scroll speed in dp per second. Default 28. Set to 0 to disable auto-scroll. */
  speed?: number;
  /** Tile width in dp. Default 96. */
  tileWidth?: number;
  /** Image dimensions in dp. */
  imageWidth?: number;
  imageHeight?: number;
  /**
   * When true and `items` is empty, render skeleton tiles instead of nothing.
   * Lets the host show a loading state for the first fetch without flashing
   * an empty space, then crossfade into the real ticker as data arrives.
   */
  isLoading?: boolean;
  /** Number of skeleton tiles to render while loading. Default 6. */
  skeletonTileCount?: number;
  style?: ViewStyle;
  testID?: string;
};

const TILE_GAP = 8;
const TILE_PADDING = 8;
const TILE_INNER_GAP = 4;
const RESUME_DELAY_MS = 1200;

/**
 * Auto-scrolling top-movers ticker. The strip glides continuously right-to-left
 * via `Animated.loop` with `useNativeDriver: true`, which means the animation
 * runs entirely on the native UI thread with zero JS↔native bridge traffic per
 * frame — important because heavy bridge traffic from a JS-driven scroll has
 * been observed to delay or drop tap events on other surfaces of the screen.
 *
 * The items list is rendered twice; the loop animates translateX from 0 to
 * `-singleListWidth` and then resets to 0. Since the second copy of the items
 * occupies the position that the first copy occupied at time 0, the reset is
 * visually invisible — the strip appears to scroll forever.
 *
 * Touching the strip pauses the animation; releasing schedules a resume after
 * `RESUME_DELAY_MS`. Manual scrubbing is intentionally not supported — see
 * the design discussion that led to this trade-off.
 */
export function TopMoversCarousel({
  items,
  onItemPress,
  speed = 28,
  tileWidth = 96,
  imageWidth = 33,
  imageHeight = 48,
  isLoading = false,
  skeletonTileCount = 6,
  style,
  testID,
}: TopMoversCarouselProps) {
  const theme = useSpotlightTheme();
  const translateX = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPaused, setIsPaused] = useState(false);

  const singleListWidth = useMemo(() => {
    if (items.length === 0) {
      return 0;
    }
    return items.length * (tileWidth + TILE_GAP);
  }, [items.length, tileWidth]);

  const shouldAutoScroll = items.length > 1 && speed > 0 && singleListWidth > 0;

  const renderedItems = shouldAutoScroll ? [...items, ...items] : items;

  useEffect(() => {
    if (!shouldAutoScroll || isPaused) {
      loopRef.current?.stop();
      loopRef.current = null;
      return;
    }

    translateX.setValue(0);
    const loopAnimation = Animated.loop(
      Animated.timing(translateX, {
        toValue: -singleListWidth,
        duration: (singleListWidth / speed) * 1000,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loopRef.current = loopAnimation;
    loopAnimation.start();

    return () => {
      loopAnimation.stop();
    };
  }, [isPaused, shouldAutoScroll, singleListWidth, speed, translateX]);

  useEffect(() => {
    return () => {
      if (resumeTimerRef.current !== null) {
        clearTimeout(resumeTimerRef.current);
      }
    };
  }, []);

  const handleTouchStart = () => {
    if (resumeTimerRef.current !== null) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    setIsPaused(true);
  };

  const handleTouchEnd = () => {
    if (resumeTimerRef.current !== null) {
      clearTimeout(resumeTimerRef.current);
    }
    resumeTimerRef.current = setTimeout(() => {
      setIsPaused(false);
      resumeTimerRef.current = null;
    }, RESUME_DELAY_MS);
  };

  if (items.length === 0) {
    if (!isLoading) {
      return null;
    }

    return (
      <View
        pointerEvents="none"
        style={[styles.container, style]}
        testID={testID ? `${testID}-skeleton` : undefined}
      >
        <View style={styles.row}>
          {Array.from({ length: skeletonTileCount }).map((_, index) => (
            <View
              key={`skeleton-${index}`}
              style={[
                styles.tile,
                {
                  backgroundColor: theme.colors.gray50,
                  borderRadius: theme.radii.sm,
                  marginRight: TILE_GAP,
                  width: tileWidth,
                },
              ]}
            >
              <SkeletonBlock height={imageHeight} radius={5} width={imageWidth} />
              <SkeletonBlock height={10} radius={2} width={tileWidth - TILE_PADDING * 2 - 8} />
              <SkeletonBlock height={10} radius={2} width={(tileWidth - TILE_PADDING * 2) / 2} />
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View
      onTouchCancel={handleTouchEnd}
      onTouchEnd={handleTouchEnd}
      onTouchStart={handleTouchStart}
      pointerEvents="box-none"
      style={[styles.container, style]}
      testID={testID}
    >
      <Animated.View style={[styles.row, { transform: [{ translateX }] }]}>
        {renderedItems.map((item, index) => {
          const isDown = item.direction === 'down';
          const changeColor = isDown ? theme.colors.redDelta : theme.colors.greenDelta;
          return (
            <Pressable
              accessibilityRole="button"
              key={`${item.id}-${index}`}
              onPress={() => onItemPress?.(item.id)}
              style={({ pressed }) => [
                styles.tile,
                {
                  backgroundColor: theme.colors.gray50,
                  borderRadius: theme.radii.sm,
                  marginRight: TILE_GAP,
                  opacity: pressed ? 0.85 : 1,
                  width: tileWidth,
                },
              ]}
              testID={testID ? `${testID}-item-${item.id}` : undefined}
            >
              <View
                style={[
                  styles.imageFrame,
                  {
                    borderRadius: 5,
                    height: imageHeight,
                    width: imageWidth,
                  },
                ]}
              >
                {item.imageUrl ? (
                  <Image
                    accessibilityIgnoresInvertColors
                    resizeMode="cover"
                    source={{ uri: item.imageUrl }}
                    style={styles.image}
                  />
                ) : (
                  <View
                    style={[
                      styles.imagePlaceholder,
                      { backgroundColor: theme.colors.gray100 },
                    ]}
                  />
                )}
              </View>
              <AppText
                color="textPrimary"
                numberOfLines={1}
                style={styles.title}
                variant="navLabel"
              >
                {item.title}
              </AppText>
              <AppText
                numberOfLines={1}
                style={[styles.change, { color: changeColor }]}
                variant="navLabel"
              >
                {item.changeLabel}
              </AppText>
            </Pressable>
          );
        })}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  change: {
    fontWeight: '500',
    textAlign: 'center',
  },
  container: {
    overflow: 'hidden',
    width: '100%',
  },
  image: {
    height: '100%',
    width: '100%',
  },
  imageFrame: {
    overflow: 'hidden',
  },
  imagePlaceholder: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
  },
  tile: {
    alignItems: 'center',
    flexDirection: 'column',
    gap: TILE_INNER_GAP,
    padding: TILE_PADDING,
  },
  title: {
    fontWeight: '500',
    textAlign: 'center',
  },
});

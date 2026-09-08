import { useCallback, useEffect, useRef } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { AppText } from './app-text';
import {
  TOP_MOVER_TILE_WIDTH,
  TopMoverTile,
  type TopMoverTileProps,
} from './top-mover-tile';

export type TopTrendsRailItem = TopMoverTileProps & { key: string };

export type TopTrendsRailProps = {
  /** Optional caption above the rail, e.g. the active slide's game. */
  caption?: string;
  items: TopTrendsRailItem[];
  /**
   * Advance one tile every N ms, wrapping to the first after the last. Pauses
   * while the user is dragging and resumes from wherever they let go. Omit
   * (or 0) for a static rail.
   */
  autoAdvanceIntervalMs?: number;
  /** Fires whenever the settled slide changes (auto-advance or a user swipe). */
  onActiveIndexChange?: (index: number) => void;
  testID?: string;
};

const RAIL_GUTTER = 16;
const TILE_GAP = 8;
const SNAP_INTERVAL = TOP_MOVER_TILE_WIDTH + TILE_GAP;

export function TopTrendsRail({
  caption,
  items,
  autoAdvanceIntervalMs = 0,
  onActiveIndexChange,
  testID,
}: TopTrendsRailProps) {
  const scrollRef = useRef<ScrollView | null>(null);
  const { width: windowWidth } = useWindowDimensions();
  // Enough trailing room that the LAST tile can also sit on the left gutter —
  // otherwise the final snap lands wherever the content runs out and the
  // caption names a slide that is only half on screen.
  const trailingGutter = Math.max(RAIL_GUTTER, windowWidth - TOP_MOVER_TILE_WIDTH - RAIL_GUTTER);
  const activeIndexRef = useRef(0);
  const draggingRef = useRef(false);
  const count = items.length;

  const settle = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(count - 1, index));
      if (clamped === activeIndexRef.current) {
        return;
      }
      activeIndexRef.current = clamped;
      onActiveIndexChange?.(clamped);
    },
    [count, onActiveIndexChange],
  );

  // Auto-advance: one timer for the rail's lifetime, re-armed when the item
  // count or interval changes. A user mid-drag wins — the tick is skipped, and
  // the next one continues from wherever they stopped (settle() tracks it).
  useEffect(() => {
    if (!autoAdvanceIntervalMs || count < 2) {
      return;
    }
    const timer = setInterval(() => {
      if (draggingRef.current) {
        return;
      }
      const next = (activeIndexRef.current + 1) % count;
      scrollRef.current?.scrollTo?.({ x: next * SNAP_INTERVAL, animated: true });
      settle(next);
    }, autoAdvanceIntervalMs);
    return () => clearInterval(timer);
  }, [autoAdvanceIntervalMs, count, settle]);

  // Items can shrink under us (a refetch); never point past the end.
  useEffect(() => {
    if (activeIndexRef.current >= count && count > 0) {
      settle(count - 1);
    }
  }, [count, settle]);

  const handleScrollEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = false;
      settle(Math.round(event.nativeEvent.contentOffset.x / SNAP_INTERVAL));
    },
    [settle],
  );

  if (count === 0) {
    return null;
  }

  return (
    <View testID={testID}>
      {caption ? (
        <AppText
          color="gray600"
          style={styles.caption}
          testID={testID ? `${testID}-caption` : undefined}
          variant="captionMedium"
        >
          {caption}
        </AppText>
      ) : null}
      <ScrollView
        contentContainerStyle={[styles.content, { paddingRight: trailingGutter }]}
        decelerationRate="fast"
        horizontal
        onMomentumScrollEnd={handleScrollEnd}
        onScrollBeginDrag={() => {
          draggingRef.current = true;
        }}
        onScrollEndDrag={handleScrollEnd}
        ref={scrollRef}
        showsHorizontalScrollIndicator={false}
        snapToAlignment="start"
        snapToInterval={SNAP_INTERVAL}
        testID={testID ? `${testID}-scroll` : undefined}
      >
        {items.map(({ key, ...tile }) => (
          <TopMoverTile
            key={key}
            {...tile}
            testID={tile.testID ?? (testID ? `${testID}-${key}` : undefined)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: {
    paddingHorizontal: RAIL_GUTTER,
    marginBottom: 8,
  },
  content: {
    paddingLeft: RAIL_GUTTER,
    gap: TILE_GAP,
    flexDirection: 'row',
  },
});

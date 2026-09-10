import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { AppText } from './app-text';
import { CarouselPagination } from './carousel-pagination';
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
   * (or 0) for a static rail. The rail LOOPS regardless of this — see the
   * clone note in the body — so a swipe past the last tile lands on the first.
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
  const count = items.length;
  /*
    INFINITE IN BOTH DIRECTIONS. The rail renders a clone of the last tile
    BEFORE the first and a clone of the first AFTER the last, and rests one
    slot in (`contentOffset.x = SNAP_INTERVAL`). Swiping forward off the last
    real tile therefore reveals the first, exactly as it would reveal any
    other neighbour; once that swipe settles on the clone, the rail jumps —
    un-animated, so the frame is identical — to the real tile it is a copy of,
    and the next swipe continues from there. Same in reverse off the first.

    A ScrollView cannot loop by itself, and asking users to swipe back through
    every game to get from the last to the first was the complaint. One item
    has nothing to loop to, so the clones only exist from two up.

    RENDERED POSITION vs REAL INDEX: with clones the scroll offset counts
    positions `0..count+1`, where 0 and `count+1` are the clones and `1..count`
    are the real tiles. `onActiveIndexChange` and the caption only ever see the
    REAL index; `positionRef` tracks the rendered one for the scroll maths.
  */
  const loop = count >= 2;
  const rendered = loop
    ? [
        { ...items[count - 1], key: `${items[count - 1].key}__head`, clone: true },
        ...items.map((item) => ({ ...item, clone: false })),
        { ...items[0], key: `${items[0].key}__tail`, clone: true },
      ]
    : items.map((item) => ({ ...item, clone: false }));
  // Without the loop the LAST tile still has to be able to sit on the left
  // gutter, or the final snap lands wherever the content runs out and the
  // caption names a slide that is only half on screen. Looping, the tail clone
  // already sits after it, so the ordinary gutter is all the rail needs.
  const trailingGutter = loop
    ? RAIL_GUTTER
    : Math.max(RAIL_GUTTER, windowWidth - TOP_MOVER_TILE_WIDTH - RAIL_GUTTER);
  const activeIndexRef = useRef(0);
  // The ref is what the scroll maths reads on every frame; the state is what
  // the pagination renders from. Both, rather than one: lifting the ref to
  // state would re-render the rail inside `settle`, and a dot bar driven off a
  // ref would never repaint.
  const [activeIndex, setActiveIndex] = useState(0);
  const positionRef = useRef(loop ? 1 : 0);
  const draggingRef = useRef(false);

  const realIndexOf = useCallback(
    (position: number) => {
      if (!loop) {
        return Math.max(0, Math.min(count - 1, position));
      }
      return (((position - 1) % count) + count) % count;
    },
    [count, loop],
  );

  const scrollToPosition = useCallback((position: number, animated: boolean) => {
    positionRef.current = position;
    scrollRef.current?.scrollTo?.({ x: position * SNAP_INTERVAL, animated });
  }, []);

  const settle = useCallback(
    (position: number) => {
      positionRef.current = position;
      const real = realIndexOf(position);
      if (real === activeIndexRef.current) {
        return;
      }
      activeIndexRef.current = real;
      setActiveIndex(real);
      onActiveIndexChange?.(real);
    },
    [onActiveIndexChange, realIndexOf],
  );

  // At rest on a clone → jump (no animation) to the real tile it copies. Only
  // once the scroll has actually STOPPED: jumping mid-momentum would visibly
  // hop, since the offset is not yet on the snap point.
  const normalize = useCallback(() => {
    if (!loop) {
      return;
    }
    if (positionRef.current === 0) {
      scrollToPosition(count, false);
    } else if (positionRef.current === count + 1) {
      scrollToPosition(1, false);
    }
  }, [count, loop, scrollToPosition]);

  // Auto-advance: one timer for the rail's lifetime, re-armed when the item
  // count or interval changes. A user mid-drag wins — the tick is skipped, and
  // the next one continues from wherever they stopped (settle() tracks it).
  // Normalizes first, so a tick that finds the rail parked on a clone (a
  // platform that never fired momentum-end) steps off the real tile instead.
  useEffect(() => {
    if (!autoAdvanceIntervalMs || count < 2) {
      return;
    }
    const timer = setInterval(() => {
      if (draggingRef.current) {
        return;
      }
      normalize();
      const next = loop ? positionRef.current + 1 : (positionRef.current + 1) % count;
      scrollToPosition(next, true);
      settle(next);
    }, autoAdvanceIntervalMs);
    return () => clearInterval(timer);
  }, [autoAdvanceIntervalMs, count, loop, normalize, scrollToPosition, settle]);

  // Items can shrink under us (a refetch); never point past the end.
  useEffect(() => {
    if (count > 0 && activeIndexRef.current >= count) {
      const last = loop ? count : count - 1;
      scrollToPosition(last, false);
      settle(last);
    }
  }, [count, loop, scrollToPosition, settle]);

  // Rest one slot in once the clones exist. `contentOffset` on the ScrollView
  // covers first mount; this covers the loop switching ON later (1 → 2+ items)
  // when the rail is already sitting at 0.
  useEffect(() => {
    if (loop && positionRef.current === 0) {
      scrollToPosition(1, false);
      settle(1);
    }
  }, [loop, scrollToPosition, settle]);

  const handleMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = false;
      settle(Math.round(event.nativeEvent.contentOffset.x / SNAP_INTERVAL));
      normalize();
    },
    [normalize, settle],
  );

  const handleDragEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = false;
      settle(Math.round(event.nativeEvent.contentOffset.x / SNAP_INTERVAL));
      // A release with no momentum gets no momentum-end; that is the one case
      // the clone jump has to happen here.
      const velocity = event.nativeEvent.velocity?.x ?? 0;
      if (Math.abs(velocity) < 0.01) {
        normalize();
      }
    },
    [normalize, settle],
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
        contentOffset={{ x: loop ? SNAP_INTERVAL : 0, y: 0 }}
        decelerationRate="fast"
        horizontal
        onMomentumScrollEnd={handleMomentumEnd}
        onScrollBeginDrag={() => {
          draggingRef.current = true;
        }}
        onScrollEndDrag={handleDragEnd}
        ref={scrollRef}
        showsHorizontalScrollIndicator={false}
        snapToAlignment="start"
        snapToInterval={SNAP_INTERVAL}
        testID={testID ? `${testID}-scroll` : undefined}
      >
        {rendered.map(({ clone, key, ...tile }) => (
          <TopMoverTile
            key={key}
            {...tile}
            // Clones are scroll scaffolding, not a second copy of the tile:
            // no testID, so "how many tiles" still counts the real ones.
            testID={clone ? undefined : (tile.testID ?? (testID ? `${testID}-${key}` : undefined))}
          />
        ))}
      </ScrollView>
      {/*
        Position indicator (Figma 5085:15541). Sits under the rail, centred on
        the SCREEN rather than on the tile, and takes the auto-advance period so
        its active bar counts the dwell down. A one-item rail draws none.
      */}
      <View style={styles.pagination}>
        <CarouselPagination
          activeIndex={activeIndex}
          count={count}
          dwellMs={autoAdvanceIntervalMs}
          testID={testID ? `${testID}-pagination` : undefined}
        />
      </View>
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
  // Same 12 the block puts between its title row and the rail, so the section
  // keeps one rhythm above and below the tiles.
  pagination: {
    marginTop: 12,
  },
});

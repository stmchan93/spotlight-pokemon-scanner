import {
  createContext,
  forwardRef,
  memo,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { Dimensions, type LayoutChangeEvent, type ScrollViewProps, StyleSheet, View, type ViewProps } from 'react-native';
import { FlashList, type FlashListRef, type ListRenderItemInfo } from '@shopify/flash-list';
import { type GestureType, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Easing,
  LinearTransition,
  type SharedValue,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollOffset,
  useSharedValue,
  withTiming,
  type EntryAnimationsValues,
} from 'react-native-reanimated';

import { useReduceMotion } from '@/features/scanner/use-reduce-motion';
import type { RecentCapture } from './scanner-screen-types';
import type { TrayStore } from '@/features/scanner/tray-store';

/*
  The scan tray as a recycled FlashList (v2). Only the rows near the viewport
  are mounted; a cell scrolled away is reused for another capture.

  Recycling means Reanimated's entering/exiting can't be trusted (a reused cell
  never mounts or unmounts), so the row motion is owned here instead:
  - delete: the removed row stays in the list as a zero-height "exiting" item
    for the exit duration and slides left + fades over the gap, while
  - the rows around it glide into place (a `layout` transition on the CELL,
    enabled only for a cell still showing the same item, so a recycled cell
    never glides across the list), and
  - insert: a capture never shown before slides in from the right (collapsed
    tray only), keyed on the capture id so it plays once.
  Same curves and durations as the old per-row Reanimated choreography.
*/

// Card-dismiss / advance choreography (design handoff "Exact spec" table).
const ROW_EXIT_DURATION_MS = 290;
const ROW_ENTER_DURATION_MS = 400;
const ROW_ENTER_OFFSET_PX = 24;
const ROW_LAYOUT_DURATION_MS = 290;
// A removed row stays (at zero height) a beat past its exit animation.
const ROW_EXIT_HOLD_MS = ROW_EXIT_DURATION_MS + 30;
// Cells may glide for this long after the list data changes; outside it (plain
// scrolling) no cell carries a layout transition at all.
const GLIDE_WINDOW_MS = 450;

const rowEnterEasing = Easing.bezier(0.2, 0.9, 0.1, 1);
const rowExitEasing = Easing.in(Easing.ease);

// Slide in from +24px on the right and fade up. Decelerate, no overshoot.
function buildRowEnterAnimation(_values: EntryAnimationsValues) {
  'worklet';
  return {
    initialValues: {
      opacity: 0,
      transform: [{ translateX: ROW_ENTER_OFFSET_PX }],
    },
    animations: {
      opacity: withTiming(1, { duration: ROW_ENTER_DURATION_MS, easing: rowEnterEasing }),
      transform: [{ translateX: withTiming(0, { duration: ROW_ENTER_DURATION_MS, easing: rowEnterEasing }) }],
    },
  };
}

const rowLayoutTransition = LinearTransition.duration(ROW_LAYOUT_DURATION_MS).easing(rowEnterEasing);

export type ScanTrayListItem =
  | { kind: 'header'; key: string; pageId: string; rowCount: number }
  /** `exitingCapture` set = the row was removed and is playing its exit. */
  | { kind: 'row'; key: string; captureId: string; exitingCapture: RecentCapture | null };

const headerKey = (pageId: string) => `page:${pageId}`;
const rowKey = (captureId: string) => `row:${captureId}`;

type PageGroups = ReadonlyMap<string, { firstCaptureId: string; rowCount: number }>;

/**
 * The list's items: a header before each binder page's first row, then the
 * rows, plus rows removed within the last ~300ms held in place (zero height)
 * so they can play their exit. Item objects are reused while unchanged so
 * FlashList's cell memo holds.
 */
export function useScanTrayItems({
  animateRemovals,
  ids,
  pageGroups,
  pageIds,
  trayStore,
}: {
  animateRemovals: boolean;
  ids: readonly string[];
  pageGroups: PageGroups;
  pageIds: readonly (string | undefined)[];
  trayStore: TrayStore;
}): ScanTrayListItem[] {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  // Every capture the store drops, as it was at its last commit (a row patch
  // doesn't re-render the screen, so a render-time snapshot could be stale).
  const removedCapturesRef = useRef(new Map<string, RecentCapture>());
  useEffect(() => {
    let previous = trayStore.getState().byId;
    return trayStore.subscribe(() => {
      const next = trayStore.getState().byId;
      if (next !== previous) {
        previous.forEach((capture, id) => {
          if (!next.has(id)) {
            removedCapturesRef.current.set(id, capture);
          }
        });
        previous = next;
      }
    });
  }, [trayStore]);

  const stateRef = useRef({
    ghosts: new Map<string, { capture: RecentCapture; expiresAt: number }>(),
    itemCache: new Map<string, ScanTrayListItem>(),
    prevDisplay: [] as ScanTrayListItem[],
    prevIds: ids,
  });
  const state = stateRef.current;
  const now = Date.now();

  if (ids !== state.prevIds) {
    if (animateRemovals && ids.length > 0) {
      const live = new Set(ids);
      state.prevIds.forEach((id) => {
        const capture = removedCapturesRef.current.get(id);
        if (!live.has(id) && capture) {
          state.ghosts.set(id, { capture, expiresAt: now + ROW_EXIT_HOLD_MS });
        }
      });
      state.ghosts.forEach((_, id) => {
        if (live.has(id)) {
          state.ghosts.delete(id);
        }
      });
    } else {
      // Emptied (clear all) or reduced motion: removals are instant, as before.
      state.ghosts.clear();
    }
    removedCapturesRef.current.clear();
    state.prevIds = ids;
  }
  state.ghosts.forEach((ghost, id) => {
    if (ghost.expiresAt <= now) {
      state.ghosts.delete(id);
    }
  });

  const nextExpiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  let soonestExpiry = Infinity;
  state.ghosts.forEach((ghost) => {
    soonestExpiry = Math.min(soonestExpiry, ghost.expiresAt);
  });
  useEffect(() => {
    if (soonestExpiry === Infinity) {
      return undefined;
    }
    nextExpiry.current = setTimeout(rerender, Math.max(0, soonestExpiry - Date.now()));
    return () => {
      if (nextExpiry.current) {
        clearTimeout(nextExpiry.current);
      }
    };
  }, [soonestExpiry]);

  const cached = (item: ScanTrayListItem): ScanTrayListItem => {
    const previous = state.itemCache.get(item.key);
    if (previous && previous.kind === item.kind) {
      if (
        (previous.kind === 'header' && item.kind === 'header' && previous.rowCount === item.rowCount)
        || (previous.kind === 'row' && item.kind === 'row' && previous.exitingCapture === item.exitingCapture)
      ) {
        return previous;
      }
    }
    state.itemCache.set(item.key, item);
    return item;
  };

  const liveItems: ScanTrayListItem[] = [];
  ids.forEach((captureId, index) => {
    const pageId = pageIds[index];
    const group = pageId ? pageGroups.get(pageId) : undefined;
    if (pageId && group?.firstCaptureId === captureId) {
      liveItems.push(cached({ key: headerKey(pageId), kind: 'header', pageId, rowCount: group.rowCount }));
    }
    liveItems.push(cached({ captureId, exitingCapture: null, key: rowKey(captureId), kind: 'row' }));
  });

  let display = liveItems;
  if (state.ghosts.size > 0) {
    // Each exiting row keeps its old slot: it follows whatever preceded it
    // last render (another exiting row included), or leads the list.
    const present = new Set(liveItems.map((item) => item.key));
    state.ghosts.forEach((_, id) => present.add(rowKey(id)));
    const followers = new Map<string | null, ScanTrayListItem[]>();
    const prev = state.prevDisplay;
    prev.forEach((item, index) => {
      if (item.kind !== 'row') {
        return;
      }
      const ghost = state.ghosts.get(item.captureId);
      if (!ghost) {
        return;
      }
      let anchor: string | null = null;
      for (let back = index - 1; back >= 0; back -= 1) {
        if (present.has(prev[back].key)) {
          anchor = prev[back].key;
          break;
        }
      }
      const list = followers.get(anchor) ?? [];
      list.push(cached({ captureId: item.captureId, exitingCapture: ghost.capture, key: item.key, kind: 'row' }));
      followers.set(anchor, list);
    });
    display = [];
    const emit = (item: ScanTrayListItem) => {
      display.push(item);
      followers.get(item.key)?.forEach(emit);
    };
    followers.get(null)?.forEach(emit);
    liveItems.forEach(emit);
  }

  if (state.itemCache.size > display.length * 2 + 32) {
    const keep = new Set(display.map((item) => item.key));
    state.itemCache.forEach((_, key) => {
      if (!keep.has(key)) {
        state.itemCache.delete(key);
      }
    });
  }

  const previousDisplay = state.prevDisplay;
  const same = previousDisplay.length === display.length
    && display.every((item, index) => previousDisplay[index] === item);
  if (!same) {
    state.prevDisplay = display;
  }
  return state.prevDisplay;
}

type TrayListContextValue = {
  enterAnimationEnabledRef: MutableRefObject<boolean>;
  glideUntilRef: MutableRefObject<number>;
  /** Bumped on every add/remove; a cell glides only for a row it showed before it. */
  mutationEpochRef: MutableRefObject<number>;
  itemsRef: MutableRefObject<ScanTrayListItem[]>;
  nativeScrollGesture: GestureType;
  reduceMotion: boolean;
  scrollOffset: SharedValue<number>;
  seenCaptureIds: Set<string>;
};

const TrayListContext = createContext<TrayListContextValue | null>(null);

function useTrayListContext(): TrayListContextValue {
  const value = useContext(TrayListContext);
  if (!value) {
    throw new Error('ScanTrayList context missing');
  }
  return value;
}

// The cell FlashList positions (absolute top). Glides only for a row it was
// already showing before the latest add/remove — a cell recycled (or first
// placed) during that change snaps, or it would slide across the list from
// wherever it last sat.
const ScanTrayCell = forwardRef<View, ViewProps & { index: number }>(function ScanTrayCell(
  { children, index, ...rest },
  ref,
) {
  const { glideUntilRef, itemsRef, mutationEpochRef, reduceMotion } = useTrayListContext();
  const item = itemsRef.current[index];
  const key = item?.key ?? null;
  const shownRef = useRef<{ epoch: number; key: string | null } | null>(null);
  if (shownRef.current?.key !== key) {
    shownRef.current = { epoch: mutationEpochRef.current, key };
  }
  const glide = !reduceMotion
    && item?.kind === 'row'
    && !item.exitingCapture
    && shownRef.current.epoch < mutationEpochRef.current
    && glideUntilRef.current > Date.now();
  return (
    <Reanimated.View {...rest} layout={glide ? rowLayoutTransition : undefined} ref={ref}>
      {children}
    </Reanimated.View>
  );
});

// FlashList's scroll view: the same gesture-arena ScrollView the tray always
// had, plus a UI-thread mirror of the offset for the tray pan worklets.
const ScanTrayScrollView = forwardRef<Reanimated.ScrollView, ScrollViewProps>(function ScanTrayScrollView(
  props,
  forwardedRef,
) {
  const { nativeScrollGesture, scrollOffset } = useTrayListContext();
  const animatedRef = useAnimatedRef<Reanimated.ScrollView>();
  useScrollOffset(animatedRef, scrollOffset);
  const setRef = useCallback((node: Reanimated.ScrollView | null) => {
    if (typeof animatedRef === 'function') {
      (animatedRef as unknown as (value: Reanimated.ScrollView | null) => void)(node);
    } else {
      (animatedRef as { current: Reanimated.ScrollView | null }).current = node;
    }
    if (typeof forwardedRef === 'function') {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  }, [animatedRef, forwardedRef]);
  return (
    <GestureDetector gesture={nativeScrollGesture}>
      <Reanimated.ScrollView {...props} ref={setRef} />
    </GestureDetector>
  );
});

type RenderRow = (captureId: string, exitingCapture: RecentCapture | null) => ReactNode;

const ScanTrayRowSlot = memo(function ScanTrayRowSlot({
  item,
  renderRow,
}: {
  item: Extract<ScanTrayListItem, { kind: 'row' }>;
  renderRow: RenderRow;
}) {
  const { enterAnimationEnabledRef, reduceMotion, seenCaptureIds } = useTrayListContext();
  const { captureId, exitingCapture } = item;
  const exiting = exitingCapture != null;

  // Decided once per capture shown in this cell: a capture no cell has shown
  // yet slides in (collapsed tray only). The wrapper is keyed on the last
  // capture that entered, so only an actual enter remounts the row.
  const enterRef = useRef<{ captureId: string; key: string; play: boolean } | null>(null);
  if (enterRef.current?.captureId !== captureId) {
    const play = !reduceMotion
      && !exiting
      && enterAnimationEnabledRef.current
      && !seenCaptureIds.has(captureId);
    enterRef.current = {
      captureId,
      key: play ? `enter:${captureId}` : enterRef.current?.key ?? 'row',
      play,
    };
  }
  useLayoutEffect(() => {
    seenCaptureIds.add(captureId);
  }, [captureId, seenCaptureIds]);

  // Exit: slide left off the row's own width + fade (ease-in).
  const exitProgress = useSharedValue(0);
  const rowWidth = useSharedValue(0);
  useLayoutEffect(() => {
    exitProgress.value = exiting
      ? withTiming(1, { duration: ROW_EXIT_DURATION_MS, easing: rowExitEasing })
      : 0;
  }, [captureId, exitProgress, exiting]);
  const exitStyle = useAnimatedStyle(() => {
    const width = rowWidth.value || Dimensions.get('window').width;
    return {
      opacity: 1 - exitProgress.value,
      transform: [{ translateX: -width * exitProgress.value }],
    };
  });
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    rowWidth.value = event.nativeEvent.layout.width;
  }, [rowWidth]);

  const { key: enterKey, play } = enterRef.current;
  return (
    <View
      pointerEvents={exiting ? 'none' : 'auto'}
      style={exiting ? styles.exitingSlot : styles.rowSlot}
    >
      <Reanimated.View entering={play ? buildRowEnterAnimation : undefined} key={enterKey}>
        <Reanimated.View onLayout={handleLayout} style={exitStyle}>
          {renderRow(captureId, exitingCapture)}
        </Reanimated.View>
      </Reanimated.View>
    </View>
  );
});

export type ScanTrayListProps = {
  contentOffset: { x: number; y: number };
  drawDistance: number;
  enterAnimationEnabledRef: MutableRefObject<boolean>;
  footer: ReactElement | null;
  /** Fixed (expanded) height: the tray viewport clips it, so the list never resizes mid-animation. */
  height: number;
  /** Tray order (newest first), each row's binder page, and each page's first row. */
  ids: readonly string[];
  listRef: Ref<FlashListRef<ScanTrayListItem>>;
  nativeScrollGesture: GestureType;
  pageGroups: PageGroups;
  pageIds: readonly (string | undefined)[];
  renderHeader: (pageId: string, rowCount: number) => ReactNode;
  renderRow: RenderRow;
  scrollEnabled: boolean;
  scrollOffset: SharedValue<number>;
  showsVerticalScrollIndicator: boolean;
  testID: string;
  trayStore: TrayStore;
};

const keyExtractor = (item: ScanTrayListItem) => item.key;
const getItemType = (item: ScanTrayListItem) => (
  item.kind === 'header' ? 'header' : item.exitingCapture ? 'exiting' : 'row'
);
const maintainVisibleContentPosition = { disabled: true } as const;

export function ScanTrayList({
  contentOffset,
  drawDistance,
  enterAnimationEnabledRef,
  footer,
  height,
  ids,
  listRef,
  nativeScrollGesture,
  pageGroups,
  pageIds,
  renderHeader,
  renderRow,
  scrollEnabled,
  scrollOffset,
  showsVerticalScrollIndicator,
  testID,
  trayStore,
}: ScanTrayListProps) {
  const reduceMotion = useReduceMotion();
  // Here, not in the screen: an exiting row's expiry re-renders only the list.
  const items = useScanTrayItems({ animateRemovals: !reduceMotion, ids, pageGroups, pageIds, trayStore });
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Glide only when scans were added/removed in a list already showing rows:
  // the first fill and an exiting row's (zero-height) expiry snap.
  const glideUntilRef = useRef(0);
  const mutationEpochRef = useRef(0);
  const idsRef = useRef(ids);
  if (idsRef.current !== ids) {
    if (idsRef.current.length > 0) {
      glideUntilRef.current = Date.now() + GLIDE_WINDOW_MS;
      mutationEpochRef.current += 1;
    }
    idsRef.current = ids;
  }
  const seenCaptureIdsRef = useRef<Set<string>>(new Set());

  const context = useMemo<TrayListContextValue>(() => ({
    enterAnimationEnabledRef,
    glideUntilRef,
    itemsRef,
    mutationEpochRef,
    nativeScrollGesture,
    reduceMotion,
    scrollOffset,
    seenCaptureIds: seenCaptureIdsRef.current,
  }), [enterAnimationEnabledRef, nativeScrollGesture, reduceMotion, scrollOffset]);

  const renderItem = useCallback(({ item }: ListRenderItemInfo<ScanTrayListItem>) => (
    item.kind === 'header'
      ? <View style={styles.headerSlot}>{renderHeader(item.pageId, item.rowCount)}</View>
      : <ScanTrayRowSlot item={item} renderRow={renderRow} />
  ), [renderHeader, renderRow]);

  const listStyle = useMemo(() => [styles.list, { height }], [height]);

  return (
    <TrayListContext.Provider value={context}>
      <FlashList
        CellRendererComponent={ScanTrayCell}
        ListFooterComponent={footer}
        bounces={false}
        contentOffset={contentOffset}
        data={items}
        drawDistance={drawDistance}
        getItemType={getItemType}
        keyExtractor={keyExtractor}
        maintainVisibleContentPosition={maintainVisibleContentPosition}
        nestedScrollEnabled
        overScrollMode="never"
        ref={listRef}
        renderItem={renderItem}
        renderScrollComponent={ScanTrayScrollView}
        scrollEnabled={scrollEnabled}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={showsVerticalScrollIndicator}
        style={listStyle}
        testID={testID}
      />
    </TrayListContext.Provider>
  );
}

// Must match the tray content-height math in scanner-screen (row 102 + gap 24,
// header 40 + gap 24).
const styles = StyleSheet.create({
  exitingSlot: {
    height: 0,
    overflow: 'visible',
    width: '100%',
  },
  headerSlot: {
    paddingBottom: 24,
    width: '100%',
  },
  // flex 0 overrides FlashList's own `flex: 1`, so `height` is the size.
  list: {
    flex: 0,
    width: '100%',
  },
  rowSlot: {
    paddingBottom: 24,
    width: '100%',
  },
});

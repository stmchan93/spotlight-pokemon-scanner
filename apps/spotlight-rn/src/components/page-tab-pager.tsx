import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Animated,
  FlatList,
  PanResponder,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type PanResponderGestureState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { DRAWER_EDGE_WIDTH } from '@/components/drawer-edge-swipe';
import { useTabsPage } from '@/contexts/tabs-page-context';

/**
 * `Animated.FlatList` / `Animated.ScrollView` with ordinary (non-animated) prop
 * types.
 *
 * A page's scroller MUST be an animated component: that is the only way an
 * `Animated.event` keeps `useNativeDriver`, which is what puts the collapsing
 * header on the UI thread instead of behind a JS round trip per scroll frame.
 * But `Animated.FlatList`'s declared instance type is not `FlatList`, so a
 * `useRef<FlatList<Row>>` no longer matches and every `contentContainerStyle` /
 * `renderItem` on the way in has to be re-typed through `AnimatedProps`.
 *
 * The cast is safe because it is a TYPE-only difference: `createAnimatedComponent`
 * finds the `AnimatedEvent` by inspecting the prop VALUE at runtime, which the
 * declared type has no bearing on, and the instance really does forward the
 * `FlatList` imperative API (`scrollToOffset`, `scrollToIndex`, …).
 */
export const AnimatedFlatList = Animated.FlatList as unknown as typeof FlatList;
export const AnimatedScrollView = Animated.ScrollView as unknown as typeof ScrollView;

/**
 * How far the finger must travel horizontally before the pager takes the
 * gesture and the pages start following it.
 *
 * Much smaller than a flick-to-switch threshold would be, because this one only
 * STARTS the drag — nothing is committed until the finger lifts, so being wrong
 * costs a snap-back rather than an unwanted tab change. It still has to be big
 * enough that the vertical scroll of a thousand-row collection is never taken:
 * that is what the dominance ratio below is for, and 14pt gives it enough travel
 * to judge on.
 */
const CLAIM_DRAG = 14;

/**
 * How much more horizontal than vertical a drag must be to count. Same 1.35 the
 * drawer and scanner-exit recognisers use, so "a horizontal swipe" means the
 * same shape everywhere in the app.
 */
const HORIZONTAL_BIAS = 1.35;

/** Fraction of a page width that commits the swipe on release. */
const COMMIT_FRACTION = 0.28;
/** …or a flick faster than this (px/ms), however short. */
const COMMIT_VELOCITY = 0.35;
/** Snap/settle duration once the finger is up. */
const SETTLE_MS = 190;

export type CollapsibleScrollTarget = {
  scrollTo?: (options: { y?: number; animated?: boolean }) => void;
  scrollToOffset?: (options: { offset: number; animated?: boolean }) => void;
};

/** Everything a page's scroller must spread onto itself. */
export type CollapsiblePageProps = {
  /**
   * Reserves room for the collapsing header + pinned tab bar, and guarantees
   * the page is tall enough to collapse the header even when it is empty.
   */
  contentContainerStyle: { minHeight: number; paddingTop: number };
  /**
   * `Animated.event` — pass it STRAIGHT through. Wrapping it in an arrow
   * function silently drops the native driver, because `createAnimatedComponent`
   * recognises the event by identity.
   */
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** So a `RefreshControl` spinner drops below the pinned chrome, not under it. */
  progressViewOffset: number;
  scrollEventThrottle: number;
};

type PageSwipeGuardApi = {
  /** Marks the in-flight touch as belonging to a horizontal scroller. */
  block: () => void;
};

const PageSwipeGuardContext = createContext<PageSwipeGuardApi | null>(null);

type PageSwipeGuardProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Wrap a HORIZONTALLY scrollable child (the collection filter chip row) so a
 * drag inside it scrolls the chips instead of paging the tabs.
 *
 * WHY THIS IS NEEDED AT ALL
 * `CollapsibleTabPager` decides in the CAPTURE phase (it has to — see the note
 * on the pager itself), and capture runs from the root down, so the pager is
 * asked before the chip row's `ScrollView` and would win every time. Nothing in
 * `gestureState` says "a descendant is a horizontal scroller", so the exclusion
 * has to be declared.
 *
 * WHY `onStartShouldSetResponderCapture`
 * It is the one hook that fires on TOUCH-DOWN for a touch landing anywhere
 * inside this subtree, which is strictly before the first move — i.e. before the
 * pager has any decision to make. A capture-phase MOVE handler would be too
 * late: capture is dispatched root→target, so the pager (the ancestor) would
 * already have decided on that very move. It always returns false, so it never
 * takes the touch away from the chips themselves.
 */
export function PageSwipeGuard({ children, style, testID }: PageSwipeGuardProps) {
  const guard = useContext(PageSwipeGuardContext);

  return (
    <View
      onStartShouldSetResponderCapture={() => {
        guard?.block();
        // Observe only. Claiming here would eat every chip tap.
        return false;
      }}
      style={style}
      testID={testID}
    >
      {children}
    </View>
  );
}

type CollapsibleTabPagerProps<V extends string> = {
  /** Force the gesture off (e.g. an edit mode the screen owns). */
  disabled?: boolean;
  /**
   * Width of the LEFT-edge band in which touches are ignored outright. Defaults
   * to `DRAWER_EDGE_WIDTH` so the two numbers can never drift apart — see
   * "NOT FIGHTING THE EDGE GESTURES" below.
   */
  edgeGuardWidth?: number;
  /** Collapses away above the tab bar as the active page scrolls. */
  header: ReactNode;
  onChange: (next: V) => void;
  /**
   * Per-page JS scroll listener. It rides on the pager's `Animated.event` as its
   * `listener`, which is the only way to keep the native driver AND still run
   * JS work (the scroll-to-top FAB, the bottom-bar minimize signal) per frame.
   */
  onPageScroll?: (page: V, event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** The page values in on-screen order, left → right. Must be stable. */
  order: readonly V[];
  /**
   * One scroll ref per page, so the pager can keep their vertical offsets in
   * step. Without this the header would jump the moment a swipe reveals a page
   * parked at a different offset.
   */
  pageRefs?: Partial<Record<V, { readonly current: CollapsibleScrollTarget | null }>>;
  renderPage: (page: V, props: CollapsiblePageProps) => ReactNode;
  /**
   * Optional externally-owned scroll offset, so the SCREEN can drive chrome of
   * its own from the same value the header collapse runs on (Home fades the
   * search pill out of its floating top bar). It is written by the pager's
   * `Animated.event`, so a consumer must only ever READ it — interpolate it,
   * never `setValue` it. Omit and the pager keeps a private value.
   */
  scrollY?: Animated.Value;
  /**
   * Extra stand-down check, evaluated at the moment of decision rather than at
   * render, for state the pager cannot see (e.g. "the collection search field
   * currently has focus", which is only knowable from the input's own
   * `isFocused()`).
   */
  shouldStandDown?: () => boolean;
  style?: StyleProp<ViewStyle>;
  /** Pins to the top once the header above it has collapsed. */
  tabBar: ReactNode;
  testID?: string;
  value: V;
};

/**
 * Collapsing profile header + pinned page-tab bar + horizontally DRAG-FOLLOWING
 * content underneath. The Twitter/X and Instagram profile shape.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SCREEN HAD TO BE TURNED INSIDE OUT FOR THIS
 * ─────────────────────────────────────────────────────────────────────────────
 * Both screens used to be ONE `FlatList` with the profile header, the tab bar
 * and the per-tab chrome all riding along in `ListHeaderComponent`, and the tabs
 * selected by swapping `data`. Drag-follow is impossible in that shape, for a
 * reason that is structural rather than a matter of effort: content that tracks
 * the finger has to have somewhere to go, so the NEIGHBOURING page must already
 * be laid out beside the current one. With one list there is only ever one page,
 * and putting three pages inside a single cell of the outer list would give that
 * cell the full height of a thousand-card collection — i.e. it would delete the
 * virtualization that makes the Collection tab usable at all.
 *
 * So the vertical scroller cannot be the outer element. It is inverted:
 *
 *   - THREE sibling scrollers, one per page, side by side in a row that
 *     translates horizontally. Each keeps its OWN virtualization, so the heavy
 *     Collection list is exactly as virtualized as it was before;
 *   - the header and tab bar are rendered ONCE, absolutely positioned above
 *     them, and translated up by the active page's scroll offset (clamped at
 *     the header's height). The header therefore still scrolls away exactly as
 *     it did, and the tab bar "pins" simply because the translation stops when
 *     the header has gone;
 *   - every page carries `paddingTop` equal to the chrome's height, so its
 *     content starts below the chrome rather than under it.
 *
 * WHY NOT `stickyHeaderIndices`
 * It was the first thing evaluated, and it does work: `VirtualizedList` maps
 * index 0 to `ListHeaderComponent` and index n+1 to data item n, so
 * `stickyHeaderIndices={[1]}` genuinely pins a tab bar rendered as the first
 * row. But it pins the bar INSIDE one list, and the content below it is that
 * same list's cells — which is the one thing drag-follow cannot work with (see
 * above). It buys the sticky bar and rules out the pager, so it is the wrong
 * half of the feature.
 *
 * WHY NOT A LIBRARY
 * `react-native-collapsible-tab-view` implements exactly this, but its peer
 * dependencies are `react-native-pager-view` AND `@shopify/flash-list` — both
 * NATIVE modules, so adopting it means a new native build and no OTA, and it
 * would additionally mean swapping the Collection list off `FlatList`. This
 * file is core-RN `Animated` + `PanResponder` only: it ships over OTA.
 *
 * WHY PanResponder AND NOT react-native-gesture-handler
 * Same reasoning as `DrawerEdgeSwipe` and `ScannerExitSwipe`, and the same
 * reasoning the retired `TopTabsPager` used when it drove this exact animation:
 * this is gesture NEGOTIATION against a scroll view, which PanResponder states
 * natively (decline with `false`, take over with `true`). The gesture-handler
 * version needs `manualActivation` plus a worklet, and committing a page means
 * calling a `useState` setter — JS — so it would have to hop back over
 * `runOnJS`, the exact shape that crashed the scan tray before (890e1d3). The
 * follow itself is an `Animated.Value.setValue` per move, which is what the old
 * pager did in production.
 *
 * WHAT THIS COSTS
 * A drag on the HEADER no longer scrolls the page. The header is a sibling
 * layer above the scrollers now, and a touch that lands on it is consumed
 * there — `pointerEvents="box-none"` lets touches through the container but not
 * through the header's own opaque content, and making the header
 * `pointerEvents="none"` would kill the follower/following/social-link taps and
 * the chart scrub. This is the standard trade of this pattern (every library
 * that implements it has the same behaviour). It only applies while the header
 * is still on screen — once collapsed, the whole screen below the pinned bar
 * scrolls normally.
 *
 * NO WRAP-AROUND
 * The row is clamped to its own extent, so a drag past either end does not
 * rubber-band into blank space, and the gesture is not claimed at all when it
 * points off the end — a horizontal drag at the edges is left to whatever is
 * underneath.
 *
 * NOT FIGHTING THE EDGE GESTURES
 * Touches starting within `edgeGuardWidth` of the LEFT edge are ignored
 * outright, in both directions. That band is spoken for twice over:
 *   - on the owner Portfolio, `DrawerEdgeSwipe` wraps this pager and opens the
 *     hamburger on an inward drag from it;
 *   - the public profile is a PUSHED stack route, so the same band is the
 *     interactive back-swipe.
 * Ignoring the whole band rather than just rightward drags costs a 24pt strip
 * of a 393pt screen and removes the ambiguity entirely. It also means the two
 * recognisers never race: `DrawerEdgeSwipe` only ever acts inside the band and
 * this one only ever acts outside it, so their thresholds stay independent.
 *
 * NOT FIGHTING THE LIST, THE CHART, OR THE CHIPS
 *   - vertical scrolling: rejected by the 1.35 horizontal-dominance test, which
 *     is measured on CUMULATIVE travel, so a scroll that wanders sideways for a
 *     frame is still a scroll;
 *   - the chart's long-press scrub: `chartScrubLockRef` stands this down, as it
 *     does the drawer. The chart arms that lock on a 6pt horizontally-dominant
 *     move, before this recogniser's 14, so a swipe starting on the chart is
 *     always the chart's;
 *   - Collection edit mode: `collectionEditing` stands this down — the edit UI
 *     owns gestures across the full screen;
 *   - the horizontal filter chip row: wrap it in `PageSwipeGuard` (see above).
 */
export function CollapsibleTabPager<V extends string>({
  disabled = false,
  edgeGuardWidth = DRAWER_EDGE_WIDTH,
  header,
  onChange,
  onPageScroll,
  order,
  pageRefs,
  renderPage,
  scrollY: scrollYProp,
  shouldStandDown,
  style,
  tabBar,
  testID = 'collapsible-tab-pager',
  value,
}: CollapsibleTabPagerProps<V>) {
  const { width, height } = useWindowDimensions();
  // Both default safely when no provider is present, so this can be rendered on
  // any screen (and in isolation) without extra wiring.
  const { chartScrubLockRef, collectionEditing } = useTabsPage();

  const [headerHeight, setHeaderHeight] = useState(0);
  const [tabBarHeight, setTabBarHeight] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  /** Vertical offset of whichever page last scrolled. Drives the header. */
  const ownScrollY = useRef(new Animated.Value(0)).current;
  const scrollY = scrollYProp ?? ownScrollY;
  /** Horizontal position of the three-page row. */
  const translateX = useRef(new Animated.Value(0)).current;

  const activeIndex = Math.max(0, order.indexOf(value));
  /** How far the chrome travels before the tab bar is pinned. */
  const collapseDistance = headerHeight;

  const latest = useRef({
    chartScrubLockRef,
    disabled: disabled || collectionEditing,
    edgeGuardWidth,
    onChange,
    onPageScroll,
    order,
    pageRefs,
    shouldStandDown,
    value,
  });
  latest.current = {
    chartScrubLockRef,
    disabled: disabled || collectionEditing,
    edgeGuardWidth,
    onChange,
    onPageScroll,
    order,
    pageRefs,
    shouldStandDown,
    value,
  };

  /** Mirrors of layout state the responder callbacks need without a rebuild. */
  const widthRef = useRef(width);
  widthRef.current = width;
  const collapseRef = useRef(collapseDistance);
  collapseRef.current = collapseDistance;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  /** Last reported vertical offset per page, for the sync at drag start. */
  const offsetsRef = useRef<Record<string, number>>({});
  /**
   * Absolute screen X where the current touch first landed. Captured on touch
   * start because `gestureState.x0` is still 0 while the move-should-set
   * decision is being made — it is only filled in once the responder is granted.
   */
  const startXRef = useRef<number | null>(null);
  /** Claims-once guard, reset on every new touch. */
  const claimedRef = useRef(false);
  /** Set by a `PageSwipeGuard` on touch-down; see that component. */
  const inHorizontalScrollerRef = useRef(false);
  /** `gestureState.dx` at the moment of the claim, so the follow starts at 0. */
  const grantDxRef = useRef(0);
  /** Index the row is settling on / settled at, so the value effect can idle. */
  const settledIndexRef = useRef(activeIndex);

  const guardApi = useMemo<PageSwipeGuardApi>(
    () => ({
      block: () => {
        inHorizontalScrollerRef.current = true;
      },
    }),
    [],
  );

  const settleTo = useCallback(
    (index: number) => {
      settledIndexRef.current = index;
      Animated.timing(translateX, {
        toValue: -index * widthRef.current,
        duration: SETTLE_MS,
        useNativeDriver: true,
      }).start();
    },
    [translateX],
  );

  // A tab TAP (or any other external change) slides the row over. Skipped while
  // the row is already settling on that index, which is the release path — it
  // has animated there itself and must not be restarted mid-flight.
  useEffect(() => {
    if (settledIndexRef.current === activeIndex) {
      return;
    }
    settleTo(activeIndex);
  }, [activeIndex, settleTo]);

  // Rotation / window resize: re-place the row without animating. Reads the
  // active index from a ref on purpose — the effect above owns index changes,
  // and this one must only fire on a width change.
  useEffect(() => {
    translateX.setValue(-activeIndexRef.current * width);
  }, [translateX, width]);

  /**
   * Park every inactive page at the active one's offset (clamped to the collapse
   * range) so a swipe cannot reveal a page whose header sits somewhere else.
   * Beyond the collapse distance the header is pinned either way, so the clamp
   * costs nothing visually and saves scrolling short pages somewhere they cannot
   * reach.
   */
  const syncPageOffsets = useCallback(() => {
    const state = latest.current;
    const refs = state.pageRefs;
    if (!refs) {
      return;
    }
    const target = Math.min(offsetsRef.current[state.value] ?? 0, Math.max(collapseRef.current, 0));
    state.order.forEach((page) => {
      if (page === state.value) {
        return;
      }
      const node = refs[page]?.current;
      if (!node || Math.abs((offsetsRef.current[page] ?? 0) - target) < 1) {
        return;
      }
      if (node.scrollToOffset) {
        node.scrollToOffset({ offset: target, animated: false });
      } else {
        node.scrollTo?.({ y: target, animated: false });
      }
    });
  }, []);

  const panResponder = useMemo(() => {
    const beginTouch = (event: GestureResponderEvent) => {
      startXRef.current = event.nativeEvent.pageX;
      claimedRef.current = false;
      // Reset BEFORE any `PageSwipeGuard` runs. Start-capture is dispatched
      // root→target, and the guard is a descendant, so its `block()` always
      // lands after this.
      inHorizontalScrollerRef.current = false;
      // Recording the start must never itself claim the gesture: at touch-down
      // a page swipe and a tap on a card are indistinguishable.
      return false;
    };

    const evaluate = (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      const state = latest.current;

      if (state.disabled || claimedRef.current) {
        return false;
      }
      // The chart's long-press scrub owns the gesture once it is active.
      if (state.chartScrubLockRef.current) {
        return false;
      }
      // The drag belongs to a horizontal scroller inside the page.
      if (inHorizontalScrollerRef.current) {
        return false;
      }
      // Screen-specific stand-down (e.g. the search field has focus).
      if (state.shouldStandDown?.() === true) {
        return false;
      }
      // One finger only. Multi-touch centroid travel is not a page swipe.
      if (gesture.numberActiveTouches !== 1) {
        return false;
      }
      // Left-edge band is spoken for by the drawer / the stack back-swipe.
      const startX = startXRef.current;
      if (startX == null || startX <= state.edgeGuardWidth) {
        return false;
      }
      // A vertical scroll that wobbles sideways is still a scroll. Cumulative
      // travel, so one sideways frame inside a long scroll cannot flip it.
      if (Math.abs(gesture.dx) <= Math.abs(gesture.dy) * HORIZONTAL_BIAS) {
        return false;
      }
      if (Math.abs(gesture.dx) < CLAIM_DRAG) {
        return false;
      }
      // No wrap-around: at either end a swipe pointing off the row is not ours,
      // so leave it to whatever is underneath rather than claiming it inertly.
      const index = activeIndexRef.current;
      const wantsNext = gesture.dx < 0;
      if (wantsNext && index >= state.order.length - 1) {
        return false;
      }
      if (!wantsNext && index <= 0) {
        return false;
      }

      claimedRef.current = true;
      // CLAIM. Taking the responder is what turns the pending press on the card
      // under the finger into an `onResponderTerminate`, so it cancels instead
      // of firing when the finger lifts — the bug `DrawerEdgeSwipe` was fixed
      // for. It is also what stops the page scrolling vertically mid-swipe.
      return true;
    };

    return PanResponder.create({
      // Capture phase, so the start is recorded even when the touch lands on a
      // greedy child. Bubble is the fallback for touches reaching this view.
      onStartShouldSetPanResponderCapture: beginTouch,
      onStartShouldSetPanResponder: beginTouch,
      // Capture is the phase that matters: it runs root→target, so it reaches
      // this wrapper before the card/chart underneath is asked, and it is
      // dispatched on every move even while the page's scroll view already holds
      // the responder — which is how a claim mid-gesture is possible at all.
      onMoveShouldSetPanResponderCapture: evaluate,
      onMoveShouldSetPanResponder: evaluate,
      onPanResponderGrant: (_event, gesture) => {
        // Start the follow from where the finger is NOW, not from where the
        // touch began, or the row would jump `CLAIM_DRAG` px on claim.
        grantDxRef.current = gesture.dx;
        // Line the neighbours up before either of them can be seen.
        syncPageOffsets();
      },
      onPanResponderMove: (_event, gesture) => {
        const pageWidth = widthRef.current;
        const base = -activeIndexRef.current * pageWidth;
        const maxTravel = -(latest.current.order.length - 1) * pageWidth;
        const next = base + (gesture.dx - grantDxRef.current);
        // Clamp to the row's own extent — no rubber-banding into blank space.
        translateX.setValue(Math.max(Math.min(next, 0), maxTravel));
      },
      onPanResponderRelease: (_event, gesture) => {
        // Never commit a page from a gesture this pager did not hold. React only
        // dispatches the release to the view that IS the responder, so on device
        // this is belt-and-braces — but `grantDxRef` would otherwise be read from
        // a previous gesture, and a stale offset is exactly the kind of thing
        // that turns a declined vertical scroll into a page change.
        if (!claimedRef.current) {
          return;
        }
        const state = latest.current;
        const pageWidth = widthRef.current;
        const travelled = gesture.dx - grantDxRef.current;
        const index = activeIndexRef.current;

        const committed =
          Math.abs(travelled) > pageWidth * COMMIT_FRACTION
          || Math.abs(gesture.vx) > COMMIT_VELOCITY;
        const wanted = committed ? index + (travelled < 0 ? 1 : -1) : index;
        const target = Math.max(0, Math.min(wanted, state.order.length - 1));

        // Animate first, then tell the screen: the row must not wait on a React
        // state round trip to start moving.
        settleTo(target);
        if (target !== index) {
          state.onChange(state.order[target]);
        }

        startXRef.current = null;
        claimedRef.current = false;
        inHorizontalScrollerRef.current = false;
      },
      onPanResponderTerminate: () => {
        // Taken away mid-drag (an incoming call, a modal): snap back to where
        // the pages were and commit nothing.
        if (claimedRef.current) {
          settleTo(activeIndexRef.current);
        }
        startXRef.current = null;
        claimedRef.current = false;
        inHorizontalScrollerRef.current = false;
      },
      // Only reached after a claim, i.e. on a confirmed page swipe. Hold it for
      // the rest of the finger-down so the list underneath cannot take it back
      // and start scrolling vertically half way through the drag.
      onPanResponderTerminationRequest: () => false,
      // Same one layer down: stop the native scroll view continuing the gesture
      // natively. Only consulted on grant.
      onShouldBlockNativeResponder: () => true,
    });
  }, [settleTo, syncPageOffsets, translateX]);

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerHeight(event.nativeEvent.layout.height);
  }, []);
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    setHeaderHeight(event.nativeEvent.layout.height);
  }, []);
  const handleTabBarLayout = useCallback((event: LayoutChangeEvent) => {
    setTabBarHeight(event.nativeEvent.layout.height);
  }, []);

  /**
   * One `Animated.event` per page, all writing the SAME `scrollY`. Only one page
   * is ever under the finger, and the inactive ones are only ever moved to an
   * offset that maps to the same clamped header position, so sharing the value
   * cannot make the header jump.
   */
  const scrollHandlers = useMemo(() => {
    const handlers = {} as Record<V, (event: NativeSyntheticEvent<NativeScrollEvent>) => void>;
    order.forEach((page) => {
      handlers[page] = Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
        listener: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          offsetsRef.current[page] = event.nativeEvent.contentOffset.y;
          latest.current.onPageScroll?.(page, event);
        },
      });
    });
    return handlers;
  }, [order, scrollY]);

  const chromeHeight = headerHeight + tabBarHeight;
  const headerTranslate = useMemo(() => {
    // `interpolate` needs a non-degenerate range; before the first layout there
    // is nothing to collapse anyway.
    const distance = Math.max(collapseDistance, 1);
    return scrollY.interpolate({
      inputRange: [0, distance],
      outputRange: [0, -distance],
      extrapolate: 'clamp',
    });
  }, [collapseDistance, scrollY]);

  const pageProps = useMemo(() => {
    const props = {} as Record<V, CollapsiblePageProps>;
    order.forEach((page) => {
      props[page] = {
        contentContainerStyle: {
          // Every page must be able to absorb the full collapse, or switching to
          // a short one (an empty Activity) would spring the header back open.
          minHeight: (containerHeight || height) + collapseDistance,
          paddingTop: chromeHeight,
        },
        onScroll: scrollHandlers[page],
        progressViewOffset: chromeHeight,
        scrollEventThrottle: 16,
      };
    });
    return props;
  }, [chromeHeight, collapseDistance, containerHeight, height, order, scrollHandlers]);

  return (
    <PageSwipeGuardContext.Provider value={guardApi}>
      <View
        /*
          Never let view flattening collapse this into an empty host view, and
          keep the PAGES as child index 0 (the chrome is rendered after them, and
          paints on top by z-order). `portfolio-screen` documents why at length:
          UIKit and react-native-screens find a screen's content scroll view by
          walking `subviews[0]`, and that walk has to reach a real scroll view or
          minimize-on-scroll for the native tab bar silently stops working. With
          the pages first it lands on the FIRST page's list — Collection, the
          default and dominant tab.
        */
        collapsable={false}
        onLayout={handleContainerLayout}
        style={[styles.root, style]}
        testID={testID}
        {...panResponder.panHandlers}
      >
        <Animated.View
          collapsable={false}
          style={[
            styles.row,
            { width: width * order.length, transform: [{ translateX }] },
          ]}
        >
          {order.map((page) => (
            <View collapsable={false} key={page} style={{ width }}>
              {renderPage(page, pageProps[page])}
            </View>
          ))}
        </Animated.View>

        <Animated.View
          // `box-none` so the container itself never swallows a touch; its
          // children (the profile header's own controls, the tab bar) still do.
          pointerEvents="box-none"
          style={[styles.chrome, { transform: [{ translateY: headerTranslate }] }]}
          testID={`${testID}-chrome`}
        >
          <View onLayout={handleHeaderLayout}>{header}</View>
          <View onLayout={handleTabBarLayout}>{tabBar}</View>
        </Animated.View>
      </View>
    </PageSwipeGuardContext.Provider>
  );
}

const styles = StyleSheet.create({
  chrome: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 2,
  },
  root: {
    flex: 1,
    overflow: 'hidden',
  },
  row: {
    flex: 1,
    flexDirection: 'row',
  },
});

import { NavigationContext } from '@react-navigation/native';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import {
  PanResponder,
  StyleSheet,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { DRAWER_EDGE_WIDTH } from '@/components/drawer-edge-swipe';
import { useTabsPage } from '@/contexts/tabs-page-context';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import {
  consumeTabLanding,
  requestTabLanding,
  resolveTabSwipe,
  subscribeTabLanding,
  swipeDirectionFromDx,
  type ChainTab,
  type InnerPagePosition,
  type LandingEdge,
  type TabSwipeTarget,
} from '@/lib/tab-swipe-chain';
import { useAuth } from '@/providers/auth-provider';

/**
 * Travel at which the chain makes its ONE decision for a touch: horizontal and
 * ours, or not. Same 14pt the inner `CollapsibleTabPager` claims at, so both
 * judge the same stretch of finger travel.
 */
const DECIDE_DRAG = 14;
/** Same horizontal-dominance ratio as the drawer and the inner pager. */
const HORIZONTAL_BIAS = 1.35;
/** Commit on release: this fraction of the screen width… */
const COMMIT_FRACTION = 0.18;
/** …or a flick at least this fast (px/ms) in the claimed direction. */
const COMMIT_VELOCITY = 0.35;

const TAB_SWITCH_RETRY_MS = 350;
const TAB_SWITCH_MAX_RETRIES = 3;

type TabSwipeGuardApi = { block: () => void };

const TabSwipeGuardContext = createContext<TabSwipeGuardApi | null>(null);

/**
 * Responder handler that marks the current touch as belonging to something
 * that owns horizontal drags (a chip row, a tray). Spread it onto an EXISTING
 * view when wrapping it in another one would disturb layout or hit-testing;
 * otherwise use `PageSwipeGuard`, which calls this too.
 */
export function useTabSwipeGuard() {
  const guard = useContext(TabSwipeGuardContext);
  return useCallback(() => {
    guard?.block();
    // Observe only — claiming here would eat every tap.
    return false;
  }, [guard]);
}

/**
 * Render-prop form of `useTabSwipeGuard`, for a screen that renders its own
 * `TabSwipeChain` and so cannot read the chain's context from its own body
 * (the scanner's tray shell). Renders no view of its own.
 */
export function TabSwipeGuardHandler({
  children,
}: {
  children: (onStartShouldSetResponderCapture: () => boolean) => ReactNode;
}) {
  const guard = useTabSwipeGuard();
  return <>{children(guard)}</>;
}

/**
 * Switch tabs through the react-navigation tab navigator — the same path as
 * the scanner's own tab bar (`(tabs)/scan.tsx`), because native tabs ignore
 * every expo-router API on Android. A dropped dispatch is retried briefly but
 * only while the SOURCE tab is still focused, so a retry can never pull the
 * user back from wherever they went next.
 *
 * Reads `NavigationContext` rather than `useNavigation()` so a screen rendered
 * outside a navigator (dev host, unit tests) gets an inert chain, not a throw.
 */
function useTabSwitch() {
  const navigation = useContext(NavigationContext);
  const retryRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    if (retryRef.current) {
      clearInterval(retryRef.current);
      retryRef.current = null;
    }
  }, []);
  useEffect(() => stop, [stop]);

  return useCallback(
    (tab: ChainTab) => {
      if (!navigation) {
        return false;
      }
      stop();
      navigation.navigate(tab as never);
      let attempts = 0;
      retryRef.current = setInterval(() => {
        attempts += 1;
        if (!navigation.isFocused() || attempts > TAB_SWITCH_MAX_RETRIES) {
          stop();
          return;
        }
        navigation.navigate(tab as never);
      }, TAB_SWITCH_RETRY_MS);
      return true;
    },
    [navigation, stop],
  );
}

/**
 * Lets a screen with inner pages open on the edge the chain asked for. Fires
 * immediately if the screen is already mounted (native tabs keep them mounted,
 * so the page is set while the switch is still in flight), or on mount for a
 * tab behind `MountOnFirstFocus`.
 */
export function useTabLanding(tab: ChainTab, onLand: (edge: LandingEdge) => void) {
  const onLandRef = useRef(onLand);
  onLandRef.current = onLand;

  useEffect(() => {
    const pending = consumeTabLanding(tab);
    if (pending) {
      onLandRef.current(pending);
    }
    return subscribeTabLanding((requested) => {
      if (requested !== tab) {
        return;
      }
      const edge = consumeTabLanding(tab);
      if (edge) {
        onLandRef.current(edge);
      }
    });
  }, [tab]);
}

type TabSwipeChainProps = {
  children: ReactNode;
  /** Stand the chain down (edit modes, open sheets, an expanded tray…). */
  disabled?: boolean;
  /** Left-edge band ignored outright; owned by `DrawerEdgeSwipe`. */
  edgeGuardWidth?: number;
  /** The screen's own pager position, when it has one. */
  inner?: InnerPagePosition | null;
  /** Checked at decision time, for state only knowable imperatively (input focus). */
  shouldStandDown?: () => boolean;
  style?: StyleProp<ViewStyle>;
  tab: ChainTab;
  testID?: string;
};

/**
 * Wraps a tab root so a completed horizontal swipe switches to the
 * neighbouring tab in bar order. "Switch on swipe": the screen does not follow
 * the finger; release past a distance or velocity threshold and the tab changes.
 *
 * WHY PanResponder (and not a gesture-handler Pan)
 * Every inner pager and edge gesture it has to yield to — `CollapsibleTabPager`
 * on Home and Social, `DrawerEdgeSwipe`, `PageSwipeGuard` — negotiates through
 * the JS responder system. A gesture-handler Pan cannot see that negotiation:
 * on activation it cancels the JS responder outright, so it would kill the inner
 * pager mid-swipe, and its activation is decided natively, before JS could read
 * the inner page index, the chart-scrub lock, or a guard set on touch-down.
 * Here the chain sits in the same capture-phase negotiation as an ANCESTOR, so
 * it is asked first and simply declines everything that is not its own:
 *
 *   - a swipe the inner pager can still take (resolveTabSwipe → 'inner');
 *   - anything starting in the left-edge drawer band;
 *   - vertical-dominant travel (decided once per touch at 14pt, so a scroll
 *     that wanders sideways later is still a scroll — the failOffsetY);
 *   - multi-touch, the chart's long-press scrub, a `PageSwipeGuard`ed
 *     horizontal scroller, `disabled` / `shouldStandDown`, guests.
 *
 * Gesture-handler children (Watchlist's Swipeable rows, the scanner tray) still
 * win where they start: an RNGH activation cancels the JS responder, and a
 * terminated chain commits nothing. The scanner tray is additionally guarded.
 */
export function TabSwipeChain({
  children,
  disabled = false,
  edgeGuardWidth = DRAWER_EDGE_WIDTH,
  inner,
  shouldStandDown,
  style,
  tab,
  testID = 'tab-swipe-chain',
}: TabSwipeChainProps) {
  const { width } = useWindowDimensions();
  const { chartScrubLockRef, collectionEditing } = useTabsPage();
  const { isGuest } = useAuth();
  const navigation = useContext(NavigationContext);
  const switchTab = useTabSwitch();

  const latest = useRef({
    chartScrubLockRef,
    edgeGuardWidth,
    inner,
    navigation,
    off: disabled || collectionEditing || isGuest,
    shouldStandDown,
    switchTab,
    tab,
    width,
  });
  latest.current = {
    chartScrubLockRef,
    edgeGuardWidth,
    inner,
    navigation,
    off: disabled || collectionEditing || isGuest,
    shouldStandDown,
    switchTab,
    tab,
    width,
  };

  const startXRef = useRef<number | null>(null);
  /** The one per-touch decision has been made (claimed or declined). */
  const decidedRef = useRef(false);
  const blockedRef = useRef(false);
  const targetRef = useRef<Extract<TabSwipeTarget, { kind: 'tab' }> | null>(null);

  const guardApi = useMemo<TabSwipeGuardApi>(
    () => ({
      block: () => {
        blockedRef.current = true;
      },
    }),
    [],
  );

  const panResponder = useMemo(() => {
    const reset = () => {
      startXRef.current = null;
      decidedRef.current = false;
      blockedRef.current = false;
      targetRef.current = null;
    };

    const beginTouch = (event: GestureResponderEvent) => {
      reset();
      // Ancestor, so this runs before any guard below it can `block()`.
      startXRef.current = event.nativeEvent.pageX;
      return false;
    };

    const evaluate = (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (decidedRef.current) {
        return false;
      }
      if (Math.max(Math.abs(gesture.dx), Math.abs(gesture.dy)) < DECIDE_DRAG) {
        return false;
      }
      decidedRef.current = true;

      const state = latest.current;
      if (state.off || blockedRef.current || state.chartScrubLockRef.current) {
        return false;
      }
      if (state.shouldStandDown?.() === true || gesture.numberActiveTouches !== 1) {
        return false;
      }
      const startX = startXRef.current;
      if (startX == null || startX <= state.edgeGuardWidth) {
        return false;
      }
      if (Math.abs(gesture.dx) <= Math.abs(gesture.dy) * HORIZONTAL_BIAS) {
        return false;
      }
      const target = resolveTabSwipe(state.tab, swipeDirectionFromDx(gesture.dx), state.inner);
      if (!target || target.kind !== 'tab') {
        // End of the chain, or the inner pager's move — leave it to the pager.
        return false;
      }
      targetRef.current = target;
      // CLAIM: cancels the press under the finger and stops the list scrolling.
      return true;
    };

    return PanResponder.create({
      onStartShouldSetPanResponderCapture: beginTouch,
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: evaluate,
      onMoveShouldSetPanResponder: evaluate,
      onPanResponderRelease: (_event, gesture) => {
        const target = targetRef.current;
        reset();
        if (!target) {
          return;
        }
        const state = latest.current;
        const forward = target.landing === 'first';
        const dx = forward ? -gesture.dx : gesture.dx;
        const vx = forward ? -gesture.vx : gesture.vx;
        if (dx < state.width * COMMIT_FRACTION && vx < COMMIT_VELOCITY) {
          return;
        }
        if (state.navigation && !state.navigation.isFocused()) {
          return;
        }
        requestTabLanding(target.tab, target.landing);
        if (state.switchTab(target.tab)) {
          capturePostHogEvent(AnalyticsEvent.tabSwipeNavigated, {
            direction: forward ? 'next' : 'previous',
            from_tab: state.tab,
            to_tab: target.tab,
          });
        }
      },
      // Taken away (an RNGH row swipe activated, a modal): commit nothing.
      onPanResponderTerminate: reset,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    });
  }, []);

  return (
    <TabSwipeGuardContext.Provider value={guardApi}>
      <View
        // A real, single-child host view: keeps the `subviews[0]` walk that
        // drives native tab-bar minimize-on-scroll intact (see `(tabs)/_layout`).
        collapsable={false}
        style={[styles.root, style]}
        testID={testID}
        {...panResponder.panHandlers}
      >
        {children}
      </View>
    </TabSwipeGuardContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});

import { type ReactNode, useMemo, useRef } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useTabsPage } from '@/contexts/tabs-page-context';
import { useAppDrawer } from '@/providers/app-drawer-provider';
import { useAuth } from '@/providers/auth-provider';

/**
 * Width of the left-edge band that arms the gesture. The retired `TopTabsPager`
 * used 40 for its start-zone test, but that zone was free there — the pager
 * owned the whole screen and only *observed* touches. Here the band is a real
 * view, so it is kept nearer the iOS system edge-pan width (~20pt) to shrink the
 * strip of Collection that stops taking touches. See OVERLAY VS WRAPPER below.
 */
export const DRAWER_EDGE_WIDTH = 24;

/** Minimum inward (rightward) travel before the drawer opens. */
const MIN_HORIZONTAL_DRAG = 12;

/**
 * How much more horizontal than vertical a drag must be to count. Same ratio the
 * pager used, so a list flick that drifts sideways never opens the drawer.
 */
const HORIZONTAL_BIAS = 1.35;

type DrawerEdgeSwipeProps = {
  /**
   * WRAPPER MODE. When children are passed the recogniser attaches to a
   * `flex: 1` container around them instead of rendering an edge strip, and
   * blocks nothing at all (see OVERLAY VS WRAPPER below).
   */
  children?: ReactNode;
  /** Force the gesture off. Guest mode is already handled internally. */
  disabled?: boolean;
  edgeWidth?: number;
  minHorizontalDrag?: number;
  /** Defaults to `useAppDrawer().openDrawer`. Mostly an escape hatch for tests. */
  onOpen?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Left-edge inward drag → open the hamburger drawer.
 *
 * Restores the gesture that lived inside `TopTabsPager`'s PanResponder before
 * Apple's native tab bar replaced the pager. Same contract as the original:
 *
 *   - the touch must start within `edgeWidth` of the left screen edge;
 *   - the drag must travel inward (dx > 0) and be clearly horizontal;
 *   - `openDrawer()` fires exactly ONCE per gesture (the move-should-set
 *     predicate is dispatched repeatedly while a finger is down);
 *   - the recogniser ALWAYS returns false, so it never becomes the responder.
 *     The drawer animates itself in; nothing underneath is interrupted, and a
 *     drag that turns out not to be a drawer swipe is left to whoever else
 *     wants it.
 *
 * WHY PanResponder AND NOT react-native-gesture-handler
 * The whole point is a detector that *declines* the gesture. PanResponder says
 * that natively — return `false` from the should-set callbacks. The gesture-
 * handler equivalent needs `manualActivation(true)` plus a worklet that never
 * activates, and the one thing it must do (call `openDrawer`) is JS state, so it
 * would have to hop back over `runOnJS` — the exact shape that has crashed this
 * app before. There is no animation being driven off the UI thread here, so
 * gesture-handler's advantage buys nothing. The app already reserves it for the
 * cases that do need it (pinch-zoom hero, Swipeable rows) and used PanResponder
 * for gesture *negotiation*, which is what this is.
 *
 * OVERLAY VS WRAPPER
 * Overlay mode (no children) is the drop-in: an absolutely positioned strip down
 * the left edge. It is the only part of the screen it covers — it renders
 * nothing else, so taps everywhere else are untouched — but touches inside that
 * strip do land on it rather than on the list beneath, because that is decided
 * by hit-testing before any responder negotiation happens. A sibling overlay
 * cannot observe a touch it does not receive; no gesture library changes that.
 * Hence the narrow default.
 *
 * Wrapper mode (`<DrawerEdgeSwipe>{content}</DrawerEdgeSwipe>`) has no such
 * cost: as an ANCESTOR of the content it sees every touch through the capture
 * phase while the list keeps receiving them normally. Prefer it if the dead
 * strip is ever noticeable.
 */
export function DrawerEdgeSwipe({
  children,
  disabled = false,
  edgeWidth = DRAWER_EDGE_WIDTH,
  minHorizontalDrag = MIN_HORIZONTAL_DRAG,
  onOpen,
  style,
  testID = 'drawer-edge-swipe',
}: DrawerEdgeSwipeProps) {
  const { openDrawer } = useAppDrawer();
  const { isGuest } = useAuth();
  // Both default safely when no provider is present, so this component can be
  // rendered on any screen (and in isolation) without extra wiring.
  const { chartScrubLockRef, collectionEditing } = useTabsPage();

  // Everything the responder callbacks read lives behind a ref, so the
  // PanResponder is created once and still sees current values.
  const latest = useRef({
    chartScrubLockRef,
    collectionEditing,
    edgeWidth,
    minHorizontalDrag,
    // Guest mode is locked out exactly as it was in the pager: a guest cannot
    // use anything in the drawer, so opening it would only be a dead end.
    open: onOpen ?? openDrawer,
    off: disabled || isGuest,
  });
  latest.current = {
    chartScrubLockRef,
    collectionEditing,
    edgeWidth,
    minHorizontalDrag,
    open: onOpen ?? openDrawer,
    off: disabled || isGuest,
  };

  /**
   * Absolute screen X where the current touch first landed. Captured on touch
   * start because `gestureState.x0` is still 0 while the move-should-set
   * decision is being made — it is only filled in once the responder is granted,
   * which for this component never happens.
   */
  const startXRef = useRef<number | null>(null);
  /** Fires-once guard, reset on every new touch. */
  const handledRef = useRef(false);

  const panResponder = useMemo(() => {
    const beginTouch = (event: GestureResponderEvent) => {
      startXRef.current = event.nativeEvent.pageX;
      handledRef.current = false;
      // Recording the start must never itself claim the gesture.
      return false;
    };

    const evaluate = (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      const state = latest.current;

      if (state.off || state.collectionEditing) {
        return false;
      }
      // Already opened for this gesture — the predicate keeps being dispatched
      // for every remaining move of the same drag.
      if (handledRef.current) {
        return false;
      }
      // The chart's long-press scrub owns the gesture once it is active; don't
      // pull the drawer over it mid-drag.
      if (state.chartScrubLockRef.current) {
        return false;
      }

      const startX = startXRef.current;
      if (startX == null || startX > state.edgeWidth) {
        return false;
      }
      // Inward only. A leftward drag from the left edge is not a drawer open.
      if (gesture.dx < state.minHorizontalDrag) {
        return false;
      }
      // A vertical scroll that wobbles sideways is still a scroll.
      if (Math.abs(gesture.dx) <= Math.abs(gesture.dy) * HORIZONTAL_BIAS) {
        return false;
      }

      handledRef.current = true;
      state.open();
      // NEVER claim. The drawer slides itself in and the touch stays with
      // whatever was already handling it.
      return false;
    };

    return PanResponder.create({
      // Capture phase, so the start is recorded even when the touch lands on a
      // greedy child (wrapper mode). Bubble is kept as the fallback for touches
      // that reach this view directly.
      onStartShouldSetPanResponderCapture: beginTouch,
      onStartShouldSetPanResponder: beginTouch,
      onMoveShouldSetPanResponderCapture: evaluate,
      onMoveShouldSetPanResponder: evaluate,
      // We never hold the responder, but be explicit about yielding it.
      onPanResponderTerminationRequest: () => true,
      onShouldBlockNativeResponder: () => false,
    });
  }, []);

  if (children != null) {
    return (
      <View style={[styles.wrapper, style]} testID={testID} {...panResponder.panHandlers}>
        {children}
      </View>
    );
  }

  return (
    <View
      accessible={false}
      // The strip has no children, so it is the only thing it can ever hit-test
      // to; it adds no invisible full-screen layer over the rest of the screen.
      pointerEvents="box-only"
      style={[styles.edge, { width: edgeWidth }, style]}
      testID={testID}
      {...panResponder.panHandlers}
    />
  );
}

const styles = StyleSheet.create({
  edge: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
  },
  wrapper: {
    flex: 1,
  },
});

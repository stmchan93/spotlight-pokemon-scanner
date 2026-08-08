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

/**
 * Minimum inward (rightward) travel before the drawer opens.
 *
 * This is also the point at which the gesture is CLAIMED, and the two must stay
 * the same number — see "WHY IT CLAIMS" below. A tap's finger jitter is a few
 * pixels at most, so 12 keeps taps in the edge band working normally.
 */
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
   * hit-tests nothing away from them (see OVERLAY VS WRAPPER below).
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
 *     predicate is dispatched repeatedly while a finger is down).
 *
 * WHY IT CLAIMS (it did not used to)
 * The original contract was "always return false, never become the responder",
 * on the reasoning that a detector which declines can never steal a scroll.
 * True — but declining also means the touch runs to completion underneath, and
 * `Pressable` fires `onPress` on release unless it was CANCELLED. So the edge
 * swipe opened the drawer *and* opened whatever collection card the finger
 * happened to start on. Nothing about the drawer needs the responder; cancelling
 * the child does, and taking the responder is the only thing in the RN responder
 * system that cancels it (the child gets `onResponderTerminate`, and Pressability
 * drops the press instead of firing it).
 *
 * The safety comes from *when* it claims, not from never claiming: the single
 * decision point below is already the point where the gesture is unambiguously a
 * drawer swipe (edge start + inward travel + horizontal dominance), and it is the
 * same instant the drawer opens. One decision, one claim, one open — they cannot
 * drift apart and leave a window where the drawer opens but the card underneath
 * is still live. Everything that fails any of those tests — taps, vertical
 * scrolls, mid-screen drags, leftward drags, chart scrubs — still returns false
 * and is never touched.
 *
 * WHY PanResponder AND NOT react-native-gesture-handler
 * The whole point is a detector that declines every gesture but one, and then
 * takes that one away from the view underneath. PanResponder says both natively:
 * return `false` from the should-set callbacks to decline, `true` to take over,
 * and the responder system handles the hand-off (including the child's
 * termination) for us. The gesture-handler equivalent needs `manualActivation`
 * plus a worklet, and the one thing this must do (call `openDrawer`) is JS
 * state, so it would have to hop back over `runOnJS` — the exact shape that has
 * crashed this app before. There is no animation being driven off the UI thread
 * here, so gesture-handler's advantage buys nothing. The app already reserves it
 * for the cases that do need it (pinch-zoom hero, Swipeable rows) and used
 * PanResponder for gesture *negotiation*, which is what this is.
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
 * phase while the list keeps receiving them normally. It is also the only mode
 * that can cancel the child, because you cannot take the responder away from a
 * view you are not an ancestor of. Prefer it.
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
   * which is strictly after the decision that grants it.
   */
  const startXRef = useRef<number | null>(null);
  /**
   * Opens-and-claims-once guard, reset on every new touch. The move-should-set
   * predicate keeps being dispatched for the rest of the drag; this makes every
   * later dispatch a no-op so the drawer opens once and the claim is not
   * re-attempted.
   */
  const handledRef = useRef(false);

  const panResponder = useMemo(() => {
    const beginTouch = (event: GestureResponderEvent) => {
      startXRef.current = event.nativeEvent.pageX;
      handledRef.current = false;
      // Recording the start must never itself claim the gesture: at touch-down
      // a drawer swipe and a tap on a card are indistinguishable, and claiming
      // on start would kill every tap in the edge band.
      return false;
    };

    const endTouch = () => {
      startXRef.current = null;
      handledRef.current = false;
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
      // CLAIM. The drawer does not need the responder — the child does not get
      // to keep it. Taking it here is what turns the collection card's pending
      // press into an `onResponderTerminate`, so the card cancels instead of
      // navigating on finger-up. Returning false here is what caused the drawer
      // to open *and* push the product detail page. See WHY IT CLAIMS above.
      return true;
    };

    return PanResponder.create({
      // Capture phase, so the start is recorded even when the touch lands on a
      // greedy child (wrapper mode). Bubble is kept as the fallback for touches
      // that reach this view directly.
      onStartShouldSetPanResponderCapture: beginTouch,
      onStartShouldSetPanResponder: beginTouch,
      // Capture is the phase that matters: it runs from the root down, so it
      // reaches this wrapper before the card/chart underneath is asked, and it
      // is dispatched on every move even while a descendant already holds the
      // responder — which is how a claim mid-gesture is possible at all.
      onMoveShouldSetPanResponderCapture: evaluate,
      onMoveShouldSetPanResponder: evaluate,
      // Only ever reached after a claim, i.e. on a confirmed drawer swipe. Hold
      // it for the rest of the finger-down so the list underneath cannot take it
      // back and start scrolling while the drawer is animating in.
      onPanResponderTerminationRequest: () => false,
      // Same reasoning one layer down: stop the native scroll view from
      // continuing the gesture natively (Android). Only consulted on grant,
      // which only happens for a confirmed drawer swipe. This is also
      // PanResponder's default — stated explicitly because the old
      // never-claiming version deliberately turned it off, and reverting that
      // is part of the fix.
      onShouldBlockNativeResponder: () => true,
      // Nothing to drive — the drawer already opened at the decision point. The
      // responder is held purely to keep the child cancelled. Clearing the start
      // means a stale coordinate can never arm the next gesture.
      onPanResponderRelease: endTouch,
      onPanResponderTerminate: endTouch,
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

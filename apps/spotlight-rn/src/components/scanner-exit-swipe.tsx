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

/**
 * Width of the left-edge band that arms the gesture. Matches
 * `DRAWER_EDGE_WIDTH` so "swipe in from the left edge" means the same distance
 * everywhere in the app, and stays inside the 40pt inset the scan reticle keeps
 * from the screen edge (see `makeRawScannerCaptureLayout`) — the tap-to-scan
 * target therefore never starts inside this band.
 */
export const SCANNER_EXIT_EDGE_WIDTH = 24;

/**
 * Minimum inward (rightward) travel before the Scanner is left. Deliberately
 * larger than the drawer's 12: opening a drawer is reversible in one tap, and
 * tearing down a live camera session to switch tabs is not, so this asks for a
 * slightly more committed drag. Still only ~2mm of travel.
 */
const MIN_HORIZONTAL_DRAG = 24;

/** How much more horizontal than vertical a drag must be to count. */
const HORIZONTAL_BIAS = 1.35;

type ScannerExitSwipeProps = {
  /** The screen this wraps. WRAPPER MODE ONLY — see the note below. */
  children: ReactNode;
  /** Force the gesture off. */
  disabled?: boolean;
  edgeWidth?: number;
  minHorizontalDrag?: number;
  /** Runs once per qualifying gesture. Same destination as the back button. */
  onExit: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Left-edge inward drag on the Scanner → switch to the Collection tab.
 *
 * The Scanner used to be a pushed route, which gave an interactive back-swipe
 * for free. It is a TAB now (`src/app/(tabs)/scan.tsx`) — see that file for why
 * the push is never coming back — so the only way out was the back button. This
 * restores the muscle memory: the same edge drag, the same destination the back
 * button uses (`navigate('index')`).
 *
 * WHY NOT `DrawerEdgeSwipe`
 * It is the same shape of recogniser and this is deliberately modelled on it,
 * but it cannot be reused here as-is:
 *
 *   - it disables itself in guest mode (correctly — a guest has nothing to do in
 *     the drawer). Guests can scan, so a guest would silently lose the exit
 *     gesture, which is the one thing this must never do.
 *   - it never claims the responder, by design (see CLAIMING below).
 *   - its remaining guards (`collectionEditing`, `chartScrubLockRef`) are
 *     Collection-screen concepts with no meaning on a camera screen.
 *
 * WRAPPER, NOT OVERLAY
 * An absolutely-positioned sibling strip does not work: hit-testing decides
 * where a touch lands before any responder negotiation, so a strip either
 * receives the touch (and the content beneath it goes dead) or never sees it.
 * `DrawerEdgeSwipe` learned that the hard way. As an ANCESTOR of the Scanner
 * this sees every touch through the CAPTURE phase while the camera, the reticle
 * and the tray keep receiving them normally.
 *
 * WHY PanResponder AND NOT react-native-gesture-handler
 * Same reasoning as `DrawerEdgeSwipe`: this is gesture *negotiation*, not an
 * animation, and the only thing it does (navigate) is JS. The gesture-handler
 * version would need a worklet hopping back over `runOnJS` — the exact shape
 * that crashed the scan tray before (890e1d3). The tray's own pan stays in
 * gesture-handler because it drives a height on the UI thread; this does not.
 *
 * NOT INTERFERING WITH THE CAMERA'S OWN GESTURES
 *   - tap-to-scan is a `Pressable` sized to the reticle, which is inset 40pt
 *     from the screen edge — a touch that starts inside the 24pt arming band
 *     cannot be a shutter press to begin with;
 *   - the tray's expand/collapse pan declares `failOffsetX([-16, 16])`, so a
 *     clearly horizontal drag is not its gesture either;
 *   - swipe-to-action tray rows open LEFTWARD (dx < 0) and are rejected by the
 *     inward-only test;
 *   - anything with more than one finger down is rejected outright, so a
 *     two-finger gesture can never be read as an exit.
 *
 * CLAIMING THE RESPONDER
 * Unlike the drawer, this DOES claim once the gesture is unambiguous, and then
 * sits on it inertly. The drawer is polite because it animates in over a screen
 * that stays put; here the screen is going away, so there is nothing left to be
 * polite to — and there is a concrete thing to stop. With the tray expanded the
 * Scanner puts a full-screen `Pressable` backdrop (`scanner-tray-collapse-
 * backdrop`) under the finger; without a claim, the exit swipe would also fire
 * its press and collapse the tray on the way out. Claiming transfers the
 * responder, the backdrop gets `onResponderTerminate`, and its press is
 * cancelled. A tap never travels far enough to trigger this, so the back
 * button and every tray control are untouched.
 */
export function ScannerExitSwipe({
  children,
  disabled = false,
  edgeWidth = SCANNER_EXIT_EDGE_WIDTH,
  minHorizontalDrag = MIN_HORIZONTAL_DRAG,
  onExit,
  style,
  testID = 'scanner-exit-swipe',
}: ScannerExitSwipeProps) {
  // Everything the responder callbacks read lives behind a ref, so the
  // PanResponder is created once and still sees current values.
  const latest = useRef({ disabled, edgeWidth, minHorizontalDrag, onExit });
  latest.current = { disabled, edgeWidth, minHorizontalDrag, onExit };

  /**
   * Absolute screen X where the current touch first landed. Captured on touch
   * start because `gestureState.x0` is still 0 while the move-should-set
   * decision is being made — it is only filled in once the responder is granted.
   */
  const startXRef = useRef<number | null>(null);
  /** Fires-once guard, reset on every new touch. */
  const handledRef = useRef(false);

  const panResponder = useMemo(() => {
    const beginTouch = (event: GestureResponderEvent) => {
      startXRef.current = event.nativeEvent.pageX;
      handledRef.current = false;
      // Recording the start must never itself claim the gesture, or every tap
      // on the camera would be swallowed.
      return false;
    };

    const evaluate = (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      const state = latest.current;

      if (state.disabled) {
        return false;
      }
      // Already exited for this gesture — the predicate keeps being dispatched
      // for every remaining move of the same drag.
      if (handledRef.current) {
        return false;
      }
      // One finger only. Multi-touch centroid travel is not an edge swipe.
      if (gesture.numberActiveTouches !== 1) {
        return false;
      }

      const startX = startXRef.current;
      if (startX == null || startX > state.edgeWidth) {
        return false;
      }
      // Inward only. A leftward drag from the left edge is a tray row opening.
      if (gesture.dx < state.minHorizontalDrag) {
        return false;
      }
      // A vertical drag that wobbles sideways is still a vertical drag (the
      // tray's expand/collapse pan wants it).
      if (Math.abs(gesture.dx) <= Math.abs(gesture.dy) * HORIZONTAL_BIAS) {
        return false;
      }

      handledRef.current = true;
      state.onExit();
      // Claim — see CLAIMING THE RESPONDER above.
      return true;
    };

    const endTouch = () => {
      startXRef.current = null;
      handledRef.current = false;
    };

    return PanResponder.create({
      // Capture phase, so the start is recorded and the decision is made even
      // when the touch lands on a greedy child (the reticle Pressable, the tray
      // backdrop). Bubble is the fallback for touches that reach this view
      // directly.
      onStartShouldSetPanResponderCapture: beginTouch,
      onStartShouldSetPanResponder: beginTouch,
      onMoveShouldSetPanResponderCapture: evaluate,
      onMoveShouldSetPanResponder: evaluate,
      // Granted only after `onExit` has already run, so the rest of the drag is
      // deliberately inert: hold the touch so nothing underneath resumes it.
      onPanResponderMove: () => {},
      onPanResponderRelease: endTouch,
      onPanResponderTerminate: endTouch,
      // Nothing is riding on keeping it; a terminated press does not restart.
      onPanResponderTerminationRequest: () => true,
      // Don't block native recognisers (the tray's gesture-handler pan, the row
      // Swipeables) — this only needs the RN responder, not the native arena.
      onShouldBlockNativeResponder: () => false,
    });
  }, []);

  return (
    <View style={[styles.wrapper, style]} testID={testID} {...panResponder.panHandlers}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
});

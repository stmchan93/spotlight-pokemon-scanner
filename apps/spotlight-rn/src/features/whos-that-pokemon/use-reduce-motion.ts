import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export type ReduceMotionState = {
  reduceMotion: boolean;
  /**
   * False until the OS has actually answered.
   *
   * `isReduceMotionEnabled()` is a PROMISE, so every component here renders at
   * least once believing motion is fine. For animation that is harmless — the
   * effect re-runs and swaps to the calm version within a frame or two, and the
   * visuals it cancels never got far enough to be seen.
   *
   * It is NOT harmless for haptics. A tap is not a frame: once the taptic engine
   * has fired, cancelling the rest of the score does not un-buzz the phone. So
   * anything that reaches the body rather than the screen has to wait for this
   * flag instead of racing it.
   */
  isResolved: boolean;
};

/**
 * Tracks the OS "Reduce Motion" setting (same pattern as HeartToggle), plus
 * whether that answer has arrived yet.
 *
 * The theater/reveal components swap their sweeps, pulses, flashes and particle
 * bursts for instant state changes when it is on.
 */
export function useReduceMotionState(): ReduceMotionState {
  const [state, setState] = useState<ReduceMotionState>({
    reduceMotion: false,
    isResolved: false,
  });

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setState({ reduceMotion: enabled, isResolved: true });
      })
      .catch(() => {
        // Default to motion-on if the query fails — but the answer IS in, and
        // holding the haptic score back forever would be worse than playing it.
        if (!cancelled) setState({ reduceMotion: false, isResolved: true });
      });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      setState({ reduceMotion: enabled, isResolved: true });
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  return state;
}

/** The setting on its own, for the layers that only need to pick an animation. */
export function useReduceMotion(): boolean {
  return useReduceMotionState().reduceMotion;
}

/**
 * Decision logic for pull-down-to-dismiss on slide-up pages (Search, Ask
 * Ekalight). Pure worklets so the gesture runs them on the UI thread and jest
 * runs them as plain functions.
 */

/** Release past this many points closes the page. */
export const PULL_DOWN_DISMISS_DISTANCE = 120;

/** A downward flick this fast (pt/s) closes the page from a shorter pull. */
export const PULL_DOWN_DISMISS_VELOCITY = 800;

/** A flick shorter than this never closes, however fast. */
export const PULL_DOWN_MIN_FLICK_DISTANCE = 24;

/** Movement before the drag counts as vertical or horizontal. */
export const PULL_DOWN_SLOP = 10;

/** Scroll offsets at or under this count as "at the top". */
export const PULL_DOWN_AT_TOP_EPSILON = 0.5;

export type PullDownTouchDecision = 'wait' | 'activate' | 'fail' | 'dismiss-keyboard';

export type PullDownTouchInput = {
  /** Finger travel since touch-down. */
  dx: number;
  dy: number;
  /** The scrollable was at the top when the finger went down. */
  startedAtTop: boolean;
  /** Touch-down Y in window coordinates. */
  startY: number;
  /** Top band left to the native swipe (iOS); 0 when there is none. */
  nativeTopZone: number;
  keyboardVisible: boolean;
  slop?: number;
};

/** Whether a touch should claim the pull, give up, or keep watching. */
export function pullDownTouchDecision({
  dx,
  dy,
  startedAtTop,
  startY,
  nativeTopZone,
  keyboardVisible,
  slop: slopInput,
}: PullDownTouchInput): PullDownTouchDecision {
  'worklet';
  // Defaults resolve in the body: the worklet closure doesn't capture
  // constants used only in parameter defaults (UI-thread crash, 2026-11-21).
  const slop = slopInput ?? PULL_DOWN_SLOP;
  // The native swipe owns its band; both moving the page would double it.
  if (nativeTopZone > 0 && startY < nativeTopZone) {
    return 'fail';
  }
  // Content scrolled down: this touch scrolls, never closes.
  if (!startedAtTop) {
    return 'fail';
  }
  const absX = Math.abs(dx);
  if (absX > slop && absX >= Math.abs(dy)) {
    return 'fail';
  }
  if (dy < -slop) {
    return 'fail';
  }
  if (dy > slop && dy > absX) {
    // First pull with the keyboard up closes the keyboard, not the page.
    return keyboardVisible ? 'dismiss-keyboard' : 'activate';
  }
  return 'wait';
}

/** Page offset for a finger travel: follows the finger, never above 0. */
export function pullDownOffset(translationY: number): number {
  'worklet';
  return translationY > 0 ? translationY : 0;
}

/** On release: close the page, or spring back. */
export function shouldDismissPullDown(
  translationY: number,
  velocityY: number,
  distanceInput?: number,
  velocityInput?: number,
): boolean {
  'worklet';
  const distance = distanceInput ?? PULL_DOWN_DISMISS_DISTANCE;
  const velocity = velocityInput ?? PULL_DOWN_DISMISS_VELOCITY;
  // Flicked back up: the user changed their mind.
  if (velocityY < -velocity / 2) {
    return false;
  }
  if (translationY >= distance) {
    return true;
  }
  return velocityY >= velocity && translationY >= PULL_DOWN_MIN_FLICK_DISTANCE;
}

export function isScrollAtTop(offsetY: number): boolean {
  'worklet';
  return offsetY <= PULL_DOWN_AT_TOP_EPSILON;
}

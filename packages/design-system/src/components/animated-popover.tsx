import { type PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/*
  iOS context-menu motion (Photos filter menu): the card grows out of its
  trigger and shrinks back into it. One 0→1 progress value drives scale +
  opacity; the consumer keeps its own Modal/backdrop and routes every close
  path through `dismiss` so the exit plays before the parent unmounts.
*/

/** Scale the card starts from / shrinks back to. */
export const POPOVER_MIN_SCALE = 0.3;

// ζ ≈ 0.84 (critically damped would be 31): reaches full size in ~245ms with a
// sub-1% overshoot, so it settles without a visible bounce.
export const POPOVER_OPEN_SPRING = {
  damping: 26,
  mass: 0.8,
  stiffness: 300,
  // We handle Reduce Motion ourselves (fade, no scale); System would skip the
  // animation entirely.
  reduceMotion: ReduceMotion.Never,
} as const;

export const POPOVER_CLOSE_DURATION_MS = 160;
const REDUCED_OPEN_DURATION_MS = 140;
const REDUCED_CLOSE_DURATION_MS = 110;
// JS-side backstop in case the UI-thread completion never arrives, so a menu
// can never get stuck open and swallowing taps.
const CLOSE_FALLBACK_SLACK_MS = 150;
const OPEN_LAYOUT_BACKSTOP_MS = 300;

export type PopoverAnchorRect = { x: number; y: number; width: number; height: number };

/** RN `transformOrigin` array: [x px from the card's left, top (0) or bottom ('100%'), z]. */
export type PopoverTransformOrigin = [number | '50%', 0 | '50%' | '100%', 0];

/** For a centered menu with no trigger to grow from: scale about its own middle. */
export const POPOVER_CENTER_ORIGIN: PopoverTransformOrigin = ['50%', '50%', 0];

export type PopoverTransition = {
  progress: SharedValue<number>;
  reduceMotion: boolean;
  /** Begin the open motion (PopoverSurface calls it once it's on screen). */
  start: () => void;
  /**
   * Animate out, then run `after` (the menu's onClose / onSelect) exactly once.
   * Further calls while closing are ignored.
   */
  dismiss: (after?: () => void) => void;
};

/**
 * Where the card grows from: the trigger's horizontal center (relative to the
 * card's left edge, clamped to its width) on the edge that faces the trigger.
 */
export function popoverTransformOrigin({
  anchor,
  cardLeft,
  cardWidth,
  opensUp,
}: {
  anchor: PopoverAnchorRect | null;
  cardLeft: number;
  cardWidth: number;
  opensUp: boolean;
}): PopoverTransformOrigin {
  const x = anchor
    ? Math.round(Math.min(Math.max(anchor.x + anchor.width / 2 - cardLeft, 0), cardWidth))
    : 0;
  return [x, opensUp ? '100%' : 0, 0];
}

function useSystemReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) {
          setReduceMotion(value);
        }
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      if (alive) {
        setReduceMotion(value);
      }
    });
    return () => {
      alive = false;
      subscription?.remove();
    };
  }, []);
  return reduceMotion;
}

/**
 * Drives a popover's open/close motion. Call it ABOVE the menu's
 * `if (!visible) return null` so it survives visibility flips.
 */
export function usePopoverTransition(visible: boolean): PopoverTransition {
  const progress = useSharedValue(0);
  const reduceMotion = useSystemReduceMotion();
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  const closingRef = useRef(false);
  const pendingRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Runs on the JS thread (via scheduleOnRN or the backstop timer); whichever
  // lands first wins, the other finds nothing pending.
  const settle = useCallback(() => {
    clearTimer();
    const after = pendingRef.current;
    pendingRef.current = null;
    after?.();
  }, [clearTimer]);

  const startedRef = useRef(false);
  const start = useCallback(() => {
    if (startedRef.current || closingRef.current) {
      return;
    }
    startedRef.current = true;
    progress.value = reduceMotionRef.current
      ? withTiming(1, {
          duration: REDUCED_OPEN_DURATION_MS,
          easing: Easing.out(Easing.quad),
          reduceMotion: ReduceMotion.Never,
        })
      : withSpring(1, POPOVER_OPEN_SPRING);
  }, [progress]);

  // The open motion starts from the surface's first layout, not here: a
  // Modal's window (esp. Android) attaches a frame or more after `visible`
  // flips, so a spring started now had finished before anything was drawn.
  useEffect(() => {
    closingRef.current = false;
    pendingRef.current = null;
    startedRef.current = false;
    clearTimer();
    progress.value = 0;
    if (!visible) {
      return;
    }
    // Backstop if layout never reports (never leave a menu invisible).
    const backstop = setTimeout(start, OPEN_LAYOUT_BACKSTOP_MS);
    return () => clearTimeout(backstop);
  }, [visible, progress, clearTimer, start]);

  useEffect(
    () => () => {
      pendingRef.current = null;
      clearTimer();
    },
    [clearTimer],
  );

  const dismiss = useCallback(
    (after?: () => void) => {
      if (closingRef.current) {
        return;
      }
      closingRef.current = true;
      pendingRef.current = after ?? null;
      const duration = reduceMotionRef.current
        ? REDUCED_CLOSE_DURATION_MS
        : POPOVER_CLOSE_DURATION_MS;
      timerRef.current = setTimeout(settle, duration + CLOSE_FALLBACK_SLACK_MS);
      progress.value = withTiming(
        0,
        { duration, easing: Easing.in(Easing.cubic), reduceMotion: ReduceMotion.Never },
        (finished) => {
          'worklet';
          if (finished) {
            scheduleOnRN(settle);
          }
        },
      );
    },
    [progress, settle],
  );

  return { dismiss, progress, reduceMotion, start };
}

type PopoverSurfaceProps = PropsWithChildren<{
  transition: PopoverTransition;
  /** From `popoverTransformOrigin` — the point the card grows out of. */
  origin: PopoverTransformOrigin;
  /** The menu's card style (position, radius, shadow…). */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}>;

/**
 * The animated card of an anchored popover. Replace the menu's card `View`
 * with this; layout, hit areas and children are unchanged.
 */
export function PopoverSurface({ children, origin, style, testID, transition }: PopoverSurfaceProps) {
  // Capture only the shared value + a boolean in the worklet, never the
  // transition object (it carries JS functions).
  const { progress, reduceMotion, start } = transition;
  const animatedStyle = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      // Opaque by ~half-way so the iOS blur isn't under partial alpha for long.
      opacity: Math.min(1, Math.max(0, p * 2)),
      transform: [{ scale: reduceMotion ? 1 : POPOVER_MIN_SCALE + (1 - POPOVER_MIN_SCALE) * p }],
    };
  }, [progress, reduceMotion]);

  return (
    <Animated.View
      onLayout={() => requestAnimationFrame(start)}
      style={[style, { transformOrigin: origin }, animatedStyle]}
      testID={testID}
    >
      {children}
    </Animated.View>
  );
}

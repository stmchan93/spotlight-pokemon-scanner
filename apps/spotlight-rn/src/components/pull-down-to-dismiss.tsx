import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  StyleSheet,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector, type NativeGesture, type PanGesture } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';

import { SLIDE_UP_DISMISS_ZONE } from '@/lib/navigation-presentation';
import {
  isScrollAtTop,
  pullDownOffset,
  pullDownTouchDecision,
  shouldDismissPullDown,
} from '@/lib/pull-down-dismiss';

/** If the page is still here this long after `onDismiss`, the back was refused: spring home. */
const DISMISS_FALLBACK_MS = 1000;
const SPRING_BACK = { damping: 22, stiffness: 260 } as const;

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/** Spread onto the page's main ScrollView / FlatList. */
export type PullDownScrollProps = {
  onScroll: (event: ScrollEvent) => void;
  onScrollEndDrag: (event: ScrollEvent) => void;
  onMomentumScrollEnd: (event: ScrollEvent) => void;
  scrollEventThrottle: number;
  /** Off while resting at the top, so a pull moves the page, not the list. */
  bounces?: boolean;
  overScrollMode?: 'auto' | 'never';
};

export type PullDownToDismissController = {
  /** Attached by `PullDownToDismiss` to the page. */
  gesture: PanGesture;
  /** Wrap the main scrollable in `<GestureDetector gesture={scrollGesture}>`. */
  scrollGesture: NativeGesture;
  scrollProps: PullDownScrollProps;
  translateY: SharedValue<number>;
  scrollOffset: SharedValue<number>;
  /** Call when the scrollable remounts (a new list starts at the top). */
  resetScroll: () => void;
};

export type UsePullDownToDismissOptions = {
  /** Close the page (router.back). Runs once per pull. */
  onDismiss: () => void;
  enabled?: boolean;
  /**
   * Top band left to the native-stack swipe. iOS has one (the route's
   * `gestureResponseDistance`); Android has none, so the pull works anywhere.
   */
  nativeTopZone?: number;
};

/**
 * Swipe down from anywhere to close a slide-up page, once its content is at
 * the top (Instagram / Photos).
 *
 * The page follows the finger; on release the content stays where it is and
 * `onDismiss` pops the route, so the native slide-down carries it off from that
 * offset — one motion, no snap back to 0 first.
 */
export function usePullDownToDismiss({
  onDismiss,
  enabled = true,
  nativeTopZone = Platform.OS === 'ios' ? SLIDE_UP_DISMISS_ZONE : 0,
}: UsePullDownToDismissOptions): PullDownToDismissController {
  const translateY = useSharedValue(0);
  const scrollOffset = useSharedValue(0);
  const startedAtTop = useSharedValue(true);
  const startY = useSharedValue(0);
  const startX = useSharedValue(0);
  const active = useSharedValue(false);
  const dismissing = useSharedValue(false);
  const keyboardVisible = useSharedValue(false);

  const [restingAtTop, setRestingAtTop] = useState(true);
  const restingAtTopRef = useRef(true);
  const setResting = useCallback((next: boolean) => {
    if (restingAtTopRef.current !== next) {
      restingAtTopRef.current = next;
      setRestingAtTop(next);
    }
  }, []);

  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => {
      keyboardVisible.value = true;
    });
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => {
      keyboardVisible.value = false;
    });
    return () => {
      show.remove();
      hide.remove();
      if (fallbackTimer.current) {
        clearTimeout(fallbackTimer.current);
      }
    };
  }, [keyboardVisible]);

  const dismiss = useCallback(() => {
    onDismissRef.current();
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
    }
    fallbackTimer.current = setTimeout(() => {
      fallbackTimer.current = null;
      dismissing.value = false;
      translateY.value = withSpring(0, SPRING_BACK);
    }, DISMISS_FALLBACK_MS);
  }, [dismissing, translateY]);

  const dismissKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  const scrollGesture = useMemo(() => Gesture.Native(), []);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .manualActivation(true)
        .simultaneousWithExternalGesture(scrollGesture)
        .onTouchesDown((event, manager) => {
          if (dismissing.value || event.numberOfTouches > 1) {
            manager.fail();
            return;
          }
          const touch = event.allTouches[0];
          startX.value = touch?.absoluteX ?? 0;
          startY.value = touch?.absoluteY ?? 0;
          startedAtTop.value = isScrollAtTop(scrollOffset.value);
        })
        .onTouchesMove((event, manager) => {
          const touch = event.allTouches[0];
          if (!touch) {
            return;
          }
          const decision = pullDownTouchDecision({
            dx: touch.absoluteX - startX.value,
            dy: touch.absoluteY - startY.value,
            keyboardVisible: keyboardVisible.value,
            nativeTopZone,
            startY: startY.value,
            startedAtTop: startedAtTop.value,
          });
          if (decision === 'activate') {
            manager.activate();
          } else if (decision === 'dismiss-keyboard') {
            runOnJS(dismissKeyboard)();
            manager.fail();
          } else if (decision === 'fail') {
            manager.fail();
          }
        })
        .onStart(() => {
          active.value = true;
        })
        .onUpdate((event) => {
          if (active.value) {
            translateY.value = pullDownOffset(event.translationY);
          }
        })
        .onEnd((event) => {
          if (!active.value) {
            return;
          }
          if (shouldDismissPullDown(event.translationY, event.velocityY)) {
            // Hold the offset; the route's own slide-down takes it from here.
            dismissing.value = true;
            runOnJS(dismiss)();
          } else {
            translateY.value = withSpring(0, SPRING_BACK);
          }
        })
        .onFinalize(() => {
          if (active.value && !dismissing.value) {
            translateY.value = withSpring(0, SPRING_BACK);
          }
          active.value = false;
        })
        .withTestId('pull-down-to-dismiss'),
    [
      active,
      dismiss,
      dismissKeyboard,
      dismissing,
      enabled,
      keyboardVisible,
      nativeTopZone,
      scrollGesture,
      scrollOffset,
      startX,
      startY,
      startedAtTop,
      translateY,
    ],
  );

  const onScroll = useCallback(
    (event: ScrollEvent) => {
      const y = event.nativeEvent.contentOffset.y;
      scrollOffset.value = y;
      if (!isScrollAtTop(y)) {
        setResting(false);
      }
    },
    [scrollOffset, setResting],
  );

  // Only "resting" once the scroll has settled at the top, so a bounce in
  // flight is never cut off by `bounces` flipping.
  const onSettle = useCallback(
    (event: ScrollEvent) => {
      const y = event.nativeEvent.contentOffset.y;
      scrollOffset.value = y;
      if (y >= 0 && isScrollAtTop(y)) {
        setResting(true);
      }
    },
    [scrollOffset, setResting],
  );

  const resetScroll = useCallback(() => {
    scrollOffset.value = 0;
    setResting(true);
  }, [scrollOffset, setResting]);

  const lockTop = enabled && restingAtTop;
  const scrollProps = useMemo<PullDownScrollProps>(
    () => ({
      onMomentumScrollEnd: onSettle,
      onScroll,
      onScrollEndDrag: onSettle,
      scrollEventThrottle: 16,
      ...(lockTop ? { bounces: false, overScrollMode: 'never' as const } : null),
    }),
    [lockTop, onScroll, onSettle],
  );

  return { gesture, resetScroll, scrollGesture, scrollOffset, scrollProps, translateY };
}

type PullDownToDismissProps = {
  controller: PullDownToDismissController;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** The page body that follows a pull-down. Pair with `usePullDownToDismiss`. */
export function PullDownToDismiss({ controller, children, style, testID }: PullDownToDismissProps) {
  const { translateY } = controller;
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <GestureDetector gesture={controller.gesture}>
      <Animated.View style={[styles.fill, style, animatedStyle]} testID={testID}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});

import * as Haptics from 'expo-haptics';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassSurface, isLiquidGlassAvailable, useSpotlightTheme } from '@spotlight/design-system';

import { EkalightAiRing, EkalightAiSparkle } from '@/components/ekalight-ai-glyph';
import { EkalightMark } from '@/components/ekalight-mark';
import { getAppTabBarHeight, useTabBarBottomInset } from '@/components/tab-pager/app-tab-bar';
import { assistantHref } from '@/features/assistant/assistant-route';
import {
  ASSISTANT_BUBBLE_SIZE,
  assistantBubbleHiddenOnRoute,
  assistantBubbleZone,
  bubbleEdgeX,
  bubbleRoutePath,
  clampToZone,
  getAssistantBubbleScannerAnchor,
  snapSide,
  subscribeAssistantBubbleScannerAnchor,
} from '@/features/assistant/page-context/assistant-bubble-zones';
import {
  readAssistantPageExtra,
  resolveAssistantOpenContext,
} from '@/features/assistant/page-context/assistant-page-context';
import {
  DEFAULT_BUBBLE_POSITION,
  persistBubblePosition,
  readBubblePosition,
  type AssistantBubblePosition,
} from '@/features/assistant/page-context/assistant-page-persistence';
import { useReduceMotion } from '@/features/scanner/use-reduce-motion';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useKeyboardVisible } from '@/lib/use-keyboard-visible';

// The purple mark inside the bubble keeps the Figma 52x48 aspect.
const MARK_WIDTH = 26;
const MARK_HEIGHT = 24;
const SPARKLE_SIZE = 14;
const BOB_DISTANCE = 3;
const BOB_HALF_PERIOD_MS = 1800;
const FADE_MS = 180;
const MOVE_MS = 260;

/**
 * The floating Ekalight bubble: rendered ONCE at the app root, above the tabs
 * and pushed screens, below native modals, the drawer and the keyboard. Tapping
 * opens Ask Ekalight with the current page as context; dragging moves it, and it
 * snaps to the nearer edge and remembers where it was left (per device).
 *
 * Each route gets a vertical band (`assistantBubbleZone`): above the tab bar on
 * tabs, clear of top bars and bottom action bars on pushed pages, and on the
 * scanner only the gap between the frame's bottom edge and the collapsed tray
 * (published by the scanner), so it never covers the "Scanning for" pill, the
 * reticle, zoom stack, SINGLE dropdown, shutter or tray handle (hidden there
 * while the tray is open). Hidden on the chat itself,
 * auth/forms, full-screen capture routes and while the keyboard is up.
 *
 * Animation is Reanimated on the UI thread (drag, snap, idle bob); Reduce
 * Motion turns the bob off and makes moves instant.
 */
export function FloatingAssistantBubble() {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const rawPathname = usePathname();
  const pathname = bubbleRoutePath(rawPathname);
  const params = useGlobalSearchParams();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const tabBarHeight = getAppTabBarHeight(useTabBarBottomInset());
  const keyboardVisible = useKeyboardVisible();
  const reduceMotion = useReduceMotion();

  const [position, setPosition] = useState<AssistantBubblePosition | null>(null);
  useEffect(() => {
    let cancelled = false;
    void readBubblePosition().then((stored) => {
      if (!cancelled) {
        setPosition(stored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const scannerAnchor = useSyncExternalStore(
    subscribeAssistantBubbleScannerAnchor,
    getAssistantBubbleScannerAnchor,
    getAssistantBubbleScannerAnchor,
  );
  const routeZone = useMemo(
    () =>
      assistantBubbleZone(pathname, {
        windowHeight: window.height,
        insetTop: insets.top,
        insetBottom: insets.bottom,
        tabBarHeight,
        scanner: scannerAnchor,
      }),
    [insets.bottom, insets.top, pathname, scannerAnchor, tabBarHeight, window.height],
  );
  // No safe spot on this route right now (e.g. the scanner tray is open): hide in place.
  const zoneRef = useRef(routeZone ?? { minY: 0, maxY: 0 });
  if (routeZone) {
    zoneRef.current = routeZone;
  }
  const zone = routeZone ?? zoneRef.current;
  const hidden =
    position == null || keyboardVisible || routeZone == null || assistantBubbleHiddenOnRoute(pathname);
  // The scanner's band is its own: dragging there never moves the height the
  // user picked for every other page.
  const ownBand = pathname === '/scan';
  const side = (position ?? DEFAULT_BUBBLE_POSITION).side;
  const targetX = bubbleEdgeX(side, window.width);
  const targetY = clampToZone((position ?? DEFAULT_BUBBLE_POSITION).y ?? zone.maxY, zone);

  const x = useSharedValue(targetX);
  const y = useSharedValue(targetY);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const visible = useSharedValue(0);
  const bob = useSharedValue(0);
  const dragging = useSharedValue(0);
  const placedRef = useRef(false);

  // Follow route / rotation / stored-position changes. The first placement is
  // instant (no fly-in from the corner on launch).
  useEffect(() => {
    if (position == null) {
      return;
    }
    if (!placedRef.current || reduceMotion) {
      placedRef.current = true;
      x.value = targetX;
      y.value = targetY;
      return;
    }
    x.value = withTiming(targetX, { duration: MOVE_MS });
    y.value = withTiming(targetY, { duration: MOVE_MS });
  }, [position, reduceMotion, targetX, targetY, x, y]);

  useEffect(() => {
    visible.value = reduceMotion ? (hidden ? 0 : 1) : withTiming(hidden ? 0 : 1, { duration: FADE_MS });
  }, [hidden, reduceMotion, visible]);

  // Idle bob: a slow 3pt float, off under Reduce Motion and while hidden.
  useEffect(() => {
    if (hidden || reduceMotion) {
      cancelAnimation(bob);
      bob.value = 0;
      return;
    }
    bob.value = withRepeat(
      withSequence(
        withTiming(-BOB_DISTANCE, { duration: BOB_HALF_PERIOD_MS }),
        withTiming(0, { duration: BOB_HALF_PERIOD_MS }),
      ),
      -1,
    );
    return () => cancelAnimation(bob);
  }, [bob, hidden, reduceMotion]);

  const savePosition = useCallback(
    (nextSide: 'left' | 'right', nextY: number) => {
      setPosition((current) => {
        const next = { side: nextSide, y: ownBand ? current?.y ?? null : nextY };
        persistBubblePosition(next);
        return next;
      });
    },
    [ownBand],
  );

  const open = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const context = resolveAssistantOpenContext(
      pathname,
      params as Record<string, string | string[] | undefined>,
      readAssistantPageExtra(),
    );
    capturePostHogEvent(AnalyticsEvent.assistantOpened, { source: 'bubble', page_kind: context.page.kind });
    router.push(assistantHref(context.source, context.cardIds, context.game, context.page));
  }, [params, pathname, router]);

  const width = window.width;
  const minY = zone.minY;
  const maxY = zone.maxY;
  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .minDistance(8)
      .onStart(() => {
        startX.value = x.value;
        startY.value = y.value;
        dragging.value = withTiming(1, { duration: 120 });
      })
      .onUpdate((event) => {
        x.value = startX.value + event.translationX;
        y.value = Math.min(Math.max(startY.value + event.translationY, minY), Math.max(minY, maxY));
      })
      .onEnd((event) => {
        const nextSide = snapSide(x.value, event.velocityX, width);
        x.value = withSpring(bubbleEdgeX(nextSide, width), { damping: 18, stiffness: 220, velocity: event.velocityX });
        runOnJS(savePosition)(nextSide, y.value);
      })
      .onFinalize(() => {
        dragging.value = withTiming(0, { duration: 160 });
      });
    const tap = Gesture.Tap()
      .maxDuration(400)
      .onEnd((_event, success) => {
        if (success) {
          runOnJS(open)();
        }
      });
    return Gesture.Exclusive(pan, tap);
  }, [dragging, maxY, minY, open, savePosition, startX, startY, width, x, y]);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: visible.value,
    transform: [
      { translateX: x.value },
      { translateY: y.value + bob.value * (1 - dragging.value) },
      { scale: (0.85 + 0.15 * visible.value) * (1 + 0.08 * dragging.value) },
    ],
  }));

  const hasGlass = isLiquidGlassAvailable();
  const radius = ASSISTANT_BUBBLE_SIZE / 2;

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill} testID="floating-assistant-layer">
      <GestureDetector gesture={gesture}>
        <Animated.View
          accessibilityHint="Opens Ask Ekalight about this page. Drag to move."
          accessibilityLabel="Ask Ekalight"
          accessibilityRole="button"
          accessible
          onAccessibilityTap={open}
          pointerEvents={hidden ? 'none' : 'auto'}
          style={[styles.bubble, hasGlass ? theme.shadows.glassPill : null, containerStyle]}
          testID="floating-assistant-bubble"
        >
          <GlassSurface
            fallbackColor={theme.colors.gray0}
            glassColorScheme="light"
            glassEffectStyle="regular"
            glassTintColor={theme.colors.frostTint}
            style={[
              styles.glass,
              hasGlass ? null : theme.shadows.glassPill,
              { borderCurve: 'continuous', borderRadius: radius },
            ]}
          >
            <EkalightMark color={theme.colors.purple500} height={MARK_HEIGHT} testID="floating-assistant-mark" width={MARK_WIDTH} />
          </GlassSurface>
          <EkalightAiRing size={ASSISTANT_BUBBLE_SIZE} />
          <View pointerEvents="none" style={styles.sparkle}>
            <EkalightAiSparkle size={SPARKLE_SIZE} />
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    borderCurve: 'continuous',
    borderRadius: ASSISTANT_BUBBLE_SIZE / 2,
    height: ASSISTANT_BUBBLE_SIZE,
    left: 0,
    position: 'absolute',
    top: 0,
    width: ASSISTANT_BUBBLE_SIZE,
  },
  glass: {
    alignItems: 'center',
    height: ASSISTANT_BUBBLE_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: ASSISTANT_BUBBLE_SIZE,
  },
  sparkle: {
    position: 'absolute',
    right: -2,
    top: -2,
  },
});

import * as Haptics from 'expo-haptics';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
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
import { useTabPagerPosition } from '@/components/tab-pager/tab-pager-motion';
import { assistantHref } from '@/features/assistant/assistant-route';
import {
  HOP_LAND_SPRING,
  HOP_MS,
  HOP_SQUASH,
  LEASH_OFFSET,
  LEASH_RELEASE_MS,
  LEASH_RETURN_SPRING,
  LEASH_SMOOTHING,
  LEASH_STRETCH,
  LEASH_TILT_DEG,
  LOOK_BACK_MS,
  LOOK_DELAY_MS,
  LOOK_HOLD_MS,
  LOOK_OUT_MS,
  LOOK_SHIFT,
  LOOK_TILT_DEG,
  hopHeight,
  leashAmount,
  lookDirection,
} from '@/features/assistant/components/assistant-bubble-motion';
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
const BOB_DISTANCE = 5;
// Peak squash as the bob lands: 3% wider, 3% shorter, over its last 1.5pt.
const BOB_SQUASH = 0.03;
const BOB_SQUASH_BAND = 1.5;
const BOB_HALF_PERIOD_MS = 1500;
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
 * Animation is Reanimated on the UI thread (drag, snap, idle bob). It also
 * "follows you" between pages (tuning in `assistant-bubble-motion.ts`): it
 * trails the outer tab swipe on a leash, hops along an arc when the route moves
 * its spot, and the mark glances back toward the page it came from. Each is its
 * own shared value composed into one transform. Reduce Motion turns all of
 * that and the bob off and makes moves instant.
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
  const bobbing = useSharedValue(0);
  const dragging = useSharedValue(0);
  /** Hop arc offset (pt, negative = up) and landing squash (0…1, springs past 0). */
  const hop = useSharedValue(0);
  const land = useSharedValue(0);
  /** Leash pull -1…1 (see `leashAmount`). */
  const leash = useSharedValue(0);
  /** Mark glance -1 (left) … 1 (right). */
  const look = useSharedValue(0);
  const placedRef = useRef(false);
  const lastRef = useRef({ hidden: true, pathname });
  const zoneMinYRef = useRef(zone.minY);
  zoneMinYRef.current = zone.minY;

  // Follow route / rotation / stored-position changes. The first placement is
  // instant (no fly-in from the corner on launch). A route change that moves
  // the spot while the bubble stays visible hops there; anything else slides.
  useEffect(() => {
    if (position == null) {
      return;
    }
    const last = lastRef.current;
    lastRef.current = { hidden, pathname };
    if (!placedRef.current || reduceMotion) {
      placedRef.current = true;
      x.value = targetX;
      y.value = targetY;
      return;
    }
    if (last.pathname === pathname || last.hidden || hidden) {
      x.value = withTiming(targetX, { duration: MOVE_MS });
      y.value = withTiming(targetY, { duration: MOVE_MS });
      return;
    }
    const fromY = y.value;
    const moved = Math.abs(x.value - targetX) > 1 || Math.abs(fromY - targetY) > 1;
    if (moved) {
      const flight = { duration: HOP_MS, easing: Easing.inOut(Easing.quad) };
      x.value = withTiming(targetX, flight);
      y.value = withTiming(targetY, flight);
      const height = hopHeight(fromY, targetY, zoneMinYRef.current);
      hop.value = withSequence(
        withTiming(-height, { duration: HOP_MS / 2, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: HOP_MS / 2, easing: Easing.in(Easing.quad) }),
      );
      land.value = withDelay(
        HOP_MS - 30,
        withSequence(withTiming(1, { duration: 60 }), withSpring(0, HOP_LAND_SPRING)),
      );
    }
    const direction = lookDirection(last.pathname, pathname);
    if (direction !== 0) {
      look.value = withDelay(
        moved ? HOP_MS : LOOK_DELAY_MS,
        withSequence(
          withTiming(direction, { duration: LOOK_OUT_MS, easing: Easing.out(Easing.quad) }),
          withDelay(LOOK_HOLD_MS, withTiming(0, { duration: LOOK_BACK_MS, easing: Easing.inOut(Easing.quad) })),
        ),
      );
    }
  }, [hidden, hop, land, look, pathname, position, reduceMotion, targetX, targetY, x, y]);

  useEffect(() => {
    visible.value = reduceMotion ? (hidden ? 0 : 1) : withTiming(hidden ? 0 : 1, { duration: FADE_MS });
  }, [hidden, reduceMotion, visible]);

  // Leash: trail the outer tab swipe off the pager's strip position, on the UI
  // thread. Each strip frame retargets the pull from the smoothed velocity and
  // queues the return spring, which only plays once the frames stop (settled).
  const pagerPosition = useTabPagerPosition();
  const noPager = useSharedValue(0);
  const strip = pagerPosition ?? noPager;
  const leashOn = useSharedValue(0);
  const stripAt = useSharedValue(0);
  const stripVelocity = useSharedValue(0);
  useEffect(() => {
    const on = !hidden && !reduceMotion;
    leashOn.value = on ? 1 : 0;
    if (!on) {
      for (const value of [leash, hop, land, look]) {
        cancelAnimation(value);
        value.value = 0;
      }
    }
  }, [hidden, hop, land, leash, leashOn, look, reduceMotion]);
  const pageWidth = window.width;
  useAnimatedReaction(
    () => strip.value,
    (current, previous) => {
      if (previous == null || leashOn.value === 0) {
        return;
      }
      const now = Date.now();
      const seconds = (now - stripAt.value) / 1000;
      stripAt.value = now;
      if (seconds <= 0 || seconds > 0.1) {
        // First frame of a new movement: no velocity yet.
        stripVelocity.value = 0;
        return;
      }
      stripVelocity.value += ((current - previous) / seconds - stripVelocity.value) * LEASH_SMOOTHING;
      leash.value = withSequence(
        withTiming(leashAmount(stripVelocity.value, pageWidth), { duration: 32 }),
        withDelay(LEASH_RELEASE_MS, withSpring(0, LEASH_RETURN_SPRING)),
      );
    },
    [pageWidth, strip],
  );

  // Idle bob: a slow 5pt float with a soft overshoot and a tiny squash on
  // landing; off under Reduce Motion and while hidden.
  useEffect(() => {
    if (hidden || reduceMotion) {
      cancelAnimation(bob);
      bob.value = 0;
      bobbing.value = 0;
      return;
    }
    bobbing.value = 1;
    // Up eases out with a soft back-overshoot (the float); down accelerates
    // into the landing so it reads as a gentle bounce. The squash in
    // `containerStyle` keys off the same value.
    bob.value = withRepeat(
      withSequence(
        withTiming(-BOB_DISTANCE, { duration: BOB_HALF_PERIOD_MS, easing: Easing.out(Easing.back(1.4)) }),
        withTiming(0, { duration: BOB_HALF_PERIOD_MS, easing: Easing.in(Easing.quad) }),
      ),
      -1,
    );
    return () => cancelAnimation(bob);
  }, [bob, bobbing, hidden, reduceMotion]);

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

  const containerStyle = useAnimatedStyle(() => {
    const idle = 1 - dragging.value;
    // 0 in the air, 1 at the bottom of the bob; never while still or dragged.
    const landing = bobbing.value * Math.max(0, 1 - Math.abs(bob.value) / BOB_SQUASH_BAND);
    // Bob landing + hop landing (the hop's springy rebound dips below 0 = a stretch).
    const squash = (BOB_SQUASH * landing + HOP_SQUASH * land.value) * idle;
    const pull = leash.value * idle;
    const stretch = Math.abs(pull) * LEASH_STRETCH;
    const scale = (0.85 + 0.15 * visible.value) * (1 + 0.08 * dragging.value);
    return {
      opacity: visible.value,
      transform: [
        // The leash: trails behind the strip's motion…
        { translateX: x.value + pull * LEASH_OFFSET },
        // Squash about the bottom edge, so it reads as landing, not shrinking.
        { translateY: y.value + (bob.value + hop.value) * idle + (ASSISTANT_BUBBLE_SIZE * squash) / 2 },
        // …leans toward the direction of travel and stretches along it.
        { rotate: `${-pull * LEASH_TILT_DEG}deg` },
        { scaleX: scale * (1 + squash) * (1 + stretch) },
        { scaleY: scale * (1 - squash) * (1 - stretch / 2) },
      ],
    };
  });

  // The look: the mark (and a little of the sparkle) glance toward the previous page.
  const lookStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: look.value * LOOK_SHIFT }, { rotate: `${look.value * LOOK_TILT_DEG}deg` }],
  }));
  const sparkleLookStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: look.value * LOOK_SHIFT * 0.6 }],
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
            <Animated.View style={lookStyle}>
              <EkalightMark color={theme.colors.purple500} height={MARK_HEIGHT} testID="floating-assistant-mark" width={MARK_WIDTH} />
            </Animated.View>
          </GlassSurface>
          <EkalightAiRing size={ASSISTANT_BUBBLE_SIZE} />
          <Animated.View pointerEvents="none" style={[styles.sparkle, sparkleLookStyle]}>
            <EkalightAiSparkle size={SPARKLE_SIZE} />
          </Animated.View>
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

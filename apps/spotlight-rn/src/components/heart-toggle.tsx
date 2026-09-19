import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

// Iconoir `Eye` / `EyeSolid` geometry (viewBox 0 0 24 24). The two icons differ
// only in whether the pupil is filled, which is exactly the toggle's transition.
const BROW_D = 'M3 13C6.6 5 17.4 5 21 13';
const PUPIL_D =
  'M12 17C10.3431 17 9 15.6569 9 14C9 12.3431 10.3431 11 12 11C13.6569 11 15 12.3431 15 14C15 15.6569 13.6569 17 12 17Z';

// `brandStrong`. A red fill reads as an error on an eye, not as an active state.
const DEFAULT_FILL = '#7000FF';
const DEFAULT_STROKE = '#B9BCC2';

// Bounce presets (scale keyframes + total duration) from the README motion
// table. The web reference uses a cubic-bezier ease-out-back; reanimated drives
// each keyframe segment with an ease-out timing, which reads close enough on a
// sub-half-second pop.
const BOUNCE: Record<WatchBounce, { frames: number[]; dur: number }> = {
  subtle: { frames: [1.18, 0.96, 1], dur: 360 },
  lively: { frames: [1.4, 0.9, 1.06, 1], dur: 460 },
  springy: { frames: [1.5, 0.82, 1.14, 0.96, 1], dur: 560 },
};

const RING_DURATION = 540;
// The echo trails the first ring by a beat so the two read as one ripple.
const ECHO_DELAY = 110;
const FILL_FADE_DURATION = 170;
const STROKE_RECOLOR_DURATION = 120;

const AnimatedPath = Animated.createAnimatedComponent(Path);

export type WatchBounce = 'subtle' | 'lively' | 'springy';

export type WatchToggleProps = {
  /** Controlled watching state. */
  filled: boolean;
  size?: number;
  /** Filled + ring color. */
  fill?: string;
  /** Resting outline color. */
  stroke?: string;
  bounce?: WatchBounce;
  /** Adds a second, trailing ring on the watch transition. */
  burst?: boolean;
  testID?: string;
};

export function WatchToggle({
  filled,
  size = 24,
  fill = DEFAULT_FILL,
  stroke = DEFAULT_STROKE,
  bounce = 'lively',
  burst = false,
  testID,
}: WatchToggleProps): JSX.Element {
  const [reduceMotion, setReduceMotion] = useState(false);
  // Track the previous `filled` so we can detect watch (false→true) vs unwatch.
  const prevFilled = useRef(filled);

  const scale = useSharedValue(1);
  const fillOpacity = useSharedValue(filled ? 1 : 0);
  const strokeMix = useSharedValue(filled ? 1 : 0);
  const ringProgress = useSharedValue(0);
  const echoProgress = useSharedValue(0);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(enabled);
      })
      .catch(() => {
        /* default to motion-on if the query fails */
      });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    const previous = prevFilled.current;
    prevFilled.current = filled;
    if (previous === filled) return;

    const isWatch = !previous && filled;

    if (reduceMotion) {
      // No bounce/rings; just swap the fill + stroke instantly.
      fillOpacity.value = filled ? 1 : 0;
      strokeMix.value = filled ? 1 : 0;
      scale.value = 1;
      return;
    }

    // Cross-fade the pupil fill and recolor the outline on every transition.
    fillOpacity.value = withTiming(filled ? 1 : 0, {
      duration: FILL_FADE_DURATION,
      easing: Easing.out(Easing.ease),
    });
    strokeMix.value = withTiming(filled ? 1 : 0, {
      duration: STROKE_RECOLOR_DURATION,
      easing: Easing.out(Easing.ease),
    });

    // Bounce on every toggle.
    const preset = BOUNCE[bounce];
    const segment = preset.dur / preset.frames.length;
    scale.value = withSequence(
      ...preset.frames.map((target) =>
        withTiming(target, { duration: segment, easing: Easing.out(Easing.ease) }),
      ),
    );

    // Ring pulse only on the WATCH transition.
    if (isWatch) {
      ringProgress.value = 0;
      ringProgress.value = withTiming(1, {
        duration: RING_DURATION,
        easing: Easing.bezier(0.2, 0.9, 0.1, 1),
      });
      if (burst) {
        echoProgress.value = 0;
        echoProgress.value = withDelay(
          ECHO_DELAY,
          withTiming(1, { duration: RING_DURATION, easing: Easing.bezier(0.2, 0.9, 0.1, 1) }),
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shared values are stable; only the inputs above should retrigger
  }, [filled, reduceMotion, bounce, burst]);

  useEffect(() => {
    return () => {
      cancelAnimation(scale);
      cancelAnimation(fillOpacity);
      cancelAnimation(strokeMix);
      cancelAnimation(ringProgress);
      cancelAnimation(echoProgress);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup; the shared values are stable
  }, []);

  const eyeStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const fillPathProps = useAnimatedProps(() => ({
    opacity: fillOpacity.value,
  }));

  const outlinePathProps = useAnimatedProps(() => ({
    // gray → fill as strokeMix goes 0 → 1.
    stroke: strokeMix.value > 0.5 ? fill : stroke,
    opacity: 1,
  }));

  const ringStyle = useAnimatedStyle(() => {
    const p = ringProgress.value;
    const ringScale = 0.55 + p * (1.7 - 0.55);
    return {
      opacity: p === 0 ? 0 : 0.55 * (1 - p),
      transform: [{ scale: ringScale }],
    };
  });

  const echoStyle = useAnimatedStyle(() => {
    const p = echoProgress.value;
    const ringScale = 0.55 + p * (2.05 - 0.55);
    return {
      // Dimmer than the lead ring so it reads as a trailing echo, not a clone.
      opacity: p === 0 ? 0 : 0.3 * (1 - p),
      transform: [{ scale: ringScale }],
    };
  });

  const ringSize = size * 0.84;
  const ringLayout = {
    width: ringSize,
    height: ringSize,
    marginLeft: -ringSize / 2,
    marginTop: -ringSize / 2,
    borderCurve: 'continuous' as const,
    borderRadius: ringSize / 2,
    borderColor: fill,
  };
  const showEcho = burst && !reduceMotion;

  return (
    <View
      pointerEvents="none"
      style={[styles.root, { width: size, height: size }]}
      testID={testID}
    >
      {/* Ring pulse layer (behind the eye), plus an optional trailing echo. */}
      {showEcho ? (
        <Animated.View pointerEvents="none" style={[styles.ring, ringLayout, echoStyle]} />
      ) : null}
      <Animated.View pointerEvents="none" style={[styles.ring, ringLayout, ringStyle]} />

      <Animated.View style={eyeStyle}>
        <Svg
          accessible={false}
          fill="none"
          height={size}
          testID={testID ? `${testID}-svg` : undefined}
          viewBox="0 0 24 24"
          width={size}
        >
          <AnimatedPath
            animatedProps={outlinePathProps}
            d={BROW_D}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
          />
          <AnimatedPath
            animatedProps={outlinePathProps}
            d={PUPIL_D}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
          />
          <AnimatedPath animatedProps={fillPathProps} d={PUPIL_D} fill={fill} />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    borderWidth: 2,
    left: '50%',
    position: 'absolute',
    top: '50%',
  },
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
});

export default WatchToggle;

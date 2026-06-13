import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

// Exact two-path vector set from the design handoff (viewBox 0 0 24 24).
const OUTLINE_D =
  'M22 8.86222C22 10.4087 21.4062 11.8941 20.3458 12.9929C17.9049 15.523 15.5374 18.1613 13.0053 20.5997C12.4249 21.1505 11.5042 21.1304 10.9488 20.5547L3.65376 12.9929C1.44875 10.7072 1.44875 7.01723 3.65376 4.73157C5.88044 2.42345 9.50794 2.42345 11.7346 4.73157L11.9998 5.00642L12.2648 4.73173C13.3324 3.6245 14.7864 3 16.3053 3C17.8242 3 19.2781 3.62444 20.3458 4.73157C21.4063 5.83045 22 7.31577 22 8.86222Z';
const FILL_D =
  'M11.9999 3.94228C13.1757 2.85872 14.7069 2.25 16.3053 2.25C18.0313 2.25 19.679 2.95977 20.8854 4.21074C22.0832 5.45181 22.75 7.1248 22.75 8.86222C22.75 10.5997 22.0831 12.2728 20.8854 13.5137C20.089 14.3393 19.2938 15.1836 18.4945 16.0323C16.871 17.7562 15.2301 19.4985 13.5256 21.14L13.5216 21.1438C12.6426 21.9779 11.2505 21.9476 10.409 21.0754L3.11399 13.5136C0.62867 10.9374 0.62867 6.78707 3.11399 4.21085C5.54605 1.68984 9.46239 1.60032 11.9999 3.94228Z';

const DEFAULT_FILL = '#ED1B4C';
const DEFAULT_STROKE = '#B9BCC2';

// Bounce presets (scale keyframes + total duration) from the README motion
// table. The web reference uses a cubic-bezier ease-out-back; reanimated drives
// each keyframe segment with an ease-out timing, which reads close enough on a
// sub-half-second pop.
const BOUNCE: Record<HeartBounce, { frames: number[]; dur: number }> = {
  subtle: { frames: [1.18, 0.96, 1], dur: 360 },
  lively: { frames: [1.4, 0.9, 1.06, 1], dur: 460 },
  springy: { frames: [1.5, 0.82, 1.14, 0.96, 1], dur: 560 },
};

const RING_DURATION = 540;
const FILL_FADE_DURATION = 170;
const STROKE_RECOLOR_DURATION = 120;
const PARTICLE_COUNT = 8;

const AnimatedPath = Animated.createAnimatedComponent(Path);

export type HeartBounce = 'subtle' | 'lively' | 'springy';

export type HeartToggleProps = {
  /** Controlled like state. */
  filled: boolean;
  size?: number;
  /** Filled + burst color. */
  fill?: string;
  /** Resting outline color. */
  stroke?: string;
  bounce?: HeartBounce;
  /** Particle burst on the like transition. */
  burst?: boolean;
  testID?: string;
};

// Deterministic-by-index particle geometry so a burst looks varied without a
// runtime RNG. Mirrors the web reference ranges: ring start at −90°, ±0.5rad
// jitter, travel 46–68px, size 12–17px, rotate ±70°, 600–760ms.
function particleSpec(index: number, count: number, heartSize: number) {
  const baseAngle = (-90 + (index / count) * 360) * (Math.PI / 180);
  const jitter = ((index % 2 === 0 ? 1 : -1) * 0.5 * ((index % 3) + 1)) / 3;
  const angle = baseAngle + jitter;
  const distance = 46 + (index / count) * 22;
  const dx = Math.cos(angle) * distance;
  const dy = Math.sin(angle) * distance;
  const rotate = ((index % 2 === 0 ? 1 : -1) * 70 * ((index % 4) + 1)) / 4;
  const dur = 600 + (index / count) * 160;
  // Particles are roughly half the heart size, varied 12→17 by index.
  const particleSize = (12 + (index % 6)) * (heartSize / 24);
  return { dx, dy, rotate, dur, particleSize };
}

type ParticleProps = {
  index: number;
  count: number;
  heartSize: number;
  color: string;
  // Re-key on each burst so the animation restarts from frame 0.
  burstKey: number;
};

function HeartParticle({ index, count, heartSize, color, burstKey }: ParticleProps) {
  const { dx, dy, rotate, dur, particleSize } = particleSpec(index, count, heartSize);
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = 0;
    progress.value = withTiming(1, {
      duration: dur,
      easing: Easing.bezier(0.2, 0.7, 0.2, 1),
    });
    return () => {
      cancelAnimation(progress);
    };
    // Restart whenever a new burst fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burstKey]);

  const style = useAnimatedStyle(() => {
    const p = progress.value;
    // scale .2 → 1 → .25 across the travel, opacity 1 → 0 at the end.
    const scale = p < 0.5 ? 0.2 + (p / 0.5) * 0.8 : 1 - ((p - 0.5) / 0.5) * 0.75;
    return {
      opacity: 1 - p,
      transform: [
        { translateX: dx * p },
        { translateY: dy * p },
        { scale },
        { rotate: `${rotate * p}deg` },
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.particle,
        { width: particleSize, height: particleSize, marginLeft: -particleSize / 2, marginTop: -particleSize / 2 },
        style,
      ]}
    >
      <Svg fill="none" height={particleSize} viewBox="0 0 24 24" width={particleSize}>
        <Path d={FILL_D} fill={color} />
      </Svg>
    </Animated.View>
  );
}

export function HeartToggle({
  filled,
  size = 24,
  fill = DEFAULT_FILL,
  stroke = DEFAULT_STROKE,
  bounce = 'lively',
  burst = false,
  testID,
}: HeartToggleProps): JSX.Element {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [burstKey, setBurstKey] = useState(0);
  // Track the previous `filled` so we can detect like (false→true) vs unlike.
  const prevFilled = useRef(filled);
  const mounted = useRef(true);

  const scale = useSharedValue(1);
  const fillOpacity = useSharedValue(filled ? 1 : 0);
  const strokeMix = useSharedValue(filled ? 1 : 0);
  const ringProgress = useSharedValue(0);

  useEffect(() => {
    mounted.current = true;
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
      mounted.current = false;
      sub.remove();
    };
  }, []);

  useEffect(() => {
    const previous = prevFilled.current;
    prevFilled.current = filled;
    if (previous === filled) return;

    const isLike = !previous && filled;

    if (reduceMotion) {
      // No bounce/ring/particles; just swap the fill + stroke instantly.
      fillOpacity.value = filled ? 1 : 0;
      strokeMix.value = filled ? 1 : 0;
      scale.value = 1;
      return;
    }

    // Cross-fade the fill and recolor the outline on every transition.
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

    // Ring pulse + particle burst only on the LIKE transition.
    if (isLike) {
      ringProgress.value = 0;
      ringProgress.value = withTiming(1, {
        duration: RING_DURATION,
        easing: Easing.bezier(0.2, 0.9, 0.1, 1),
      });
      if (burst) {
        runOnJS(setBurstKey)(burstKey + 1);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filled, reduceMotion, bounce, burst]);

  useEffect(() => {
    return () => {
      cancelAnimation(scale);
      cancelAnimation(fillOpacity);
      cancelAnimation(strokeMix);
      cancelAnimation(ringProgress);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const heartStyle = useAnimatedStyle(() => ({
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

  const ringSize = size * 0.84;
  const showBurst = burst && burstKey > 0 && !reduceMotion;

  return (
    <View
      pointerEvents="none"
      style={[styles.root, { width: size, height: size }]}
      testID={testID}
    >
      {/* Ring pulse layer (behind the heart). */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.ring,
          {
            width: ringSize,
            height: ringSize,
            marginLeft: -ringSize / 2,
            marginTop: -ringSize / 2,
            borderRadius: ringSize / 2,
            borderColor: fill,
          },
          ringStyle,
        ]}
      />

      {/* Particle burst layer. */}
      {showBurst ? (
        <View pointerEvents="none" style={styles.fx}>
          {Array.from({ length: PARTICLE_COUNT }, (_, index) => (
            <HeartParticle
              burstKey={burstKey}
              color={fill}
              count={PARTICLE_COUNT}
              heartSize={size}
              index={index}
              key={index}
            />
          ))}
        </View>
      ) : null}

      <Animated.View style={heartStyle}>
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
            d={OUTLINE_D}
            fill="none"
            strokeLinejoin="round"
            strokeWidth={1.5}
          />
          <AnimatedPath animatedProps={fillPathProps} d={FILL_D} fill={fill} />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  fx: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  particle: {
    left: '50%',
    position: 'absolute',
    top: '50%',
  },
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

export default HeartToggle;

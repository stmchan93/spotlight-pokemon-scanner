import { BlurView } from 'expo-blur';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { colors } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';

import { useReduceMotion } from '../use-reduce-motion';
import { SelfieImage } from './selfie-image';

const isTestEnv = process.env.NODE_ENV === 'test';

// The reveal is styled after the Pokémon evolution sequence: a dark stage, an
// accelerating white strobe where the "form" charges up (the selfie flickers
// between flashes), a full white-out, then the matched species blooms out of
// the light with a sparkle burst.
//
// Strobe pulses as [rampUpMs, fadeDownMs], accelerating toward the white-out.
// Peaks ramp from a glimpse-through flash to a full blowout.
const STROBE_PULSES: readonly (readonly [number, number])[] = [
  [170, 200],
  [140, 165],
  [115, 135],
  [95, 110],
  [80, 95],
  [70, 85],
];
const STROBE_PEAKS = [0.88, 0.92, 0.95, 0.97, 1, 1];
const WHITEOUT_UP_MS = 150;
const WHITEOUT_HOLD_MS = 90;
const WHITEOUT_DOWN_MS = 560;

const STROBE_MS = STROBE_PULSES.reduce((sum, [up, down]) => sum + up + down, 0);
// The form swaps under the full white-out so the selfie is never seen crossfading
// into the artwork — it flickers away and the Pokémon flickers in, evolution-style.
const SWAP_AT_MS = STROBE_MS + WHITEOUT_UP_MS;

// Total morph runtime before onDone fires. Shortened under jest so screen tests
// can walk capture → scanning → reveal → result on real timers.
const MORPH_DONE_MS = isTestEnv
  ? 40
  : SWAP_AT_MS + WHITEOUT_HOLD_MS + WHITEOUT_DOWN_MS + 280;
const REDUCED_DONE_MS = isTestEnv ? 40 : 900;
const BURST_AT_MS = SWAP_AT_MS + WHITEOUT_HOLD_MS + 40;
const PARTICLE_COUNT = 14;

type RevealMorphProps = {
  /** Local uri of the selfie that dissolves away. */
  selfieUri: string | null;
  /** Official artwork of the matched species that crossfades in. */
  artworkUrl: string;
  /** Top selfie palette swatch — tints the dissolve wash. */
  washColor: string;
  /** Palette colors cycled across the particle burst. */
  burstColors: string[];
  /** Fired once the morph has fully played. */
  onDone: () => void;
  testID?: string;
};

// Deterministic-by-index particle geometry adapted from HeartToggle's
// particleSpec (ring start at −90°, jitter, 46–68px travel, 600–760ms).
function particleSpec(index: number, count: number) {
  const baseAngle = (-90 + (index / count) * 360) * (Math.PI / 180);
  const jitter = ((index % 2 === 0 ? 1 : -1) * 0.5 * ((index % 3) + 1)) / 3;
  const angle = baseAngle + jitter;
  const distance = 72 + (index / count) * 46;
  const dx = Math.cos(angle) * distance;
  const dy = Math.sin(angle) * distance;
  const dur = 600 + (index / count) * 160;
  const particleSize = 8 + (index % 5) * 2;
  return { dx, dy, dur, particleSize };
}

function BurstParticle({
  index,
  color,
}: {
  index: number;
  color: string;
}) {
  const { dx, dy, dur, particleSize } = particleSpec(index, PARTICLE_COUNT);
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, {
      duration: dur,
      easing: Easing.bezier(0.2, 0.7, 0.2, 1),
    });
    return () => {
      cancelAnimation(progress);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = useAnimatedStyle(() => {
    const p = progress.value;
    const scale = p < 0.5 ? 0.2 + (p / 0.5) * 0.8 : 1 - ((p - 0.5) / 0.5) * 0.75;
    return {
      opacity: 1 - p,
      transform: [{ translateX: dx * p }, { translateY: dy * p }, { scale }],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.particle,
        {
          backgroundColor: color,
          borderRadius: particleSize / 2,
          height: particleSize,
          marginLeft: -particleSize / 2,
          marginTop: -particleSize / 2,
          width: particleSize,
        },
        style,
      ]}
    />
  );
}

/**
 * Dissolve morph: the selfie scales up slightly while a blur + palette-tinted
 * color wash swallows it, then the matched species' official artwork
 * crossfades in with a palette-colored particle burst. Calls `onDone` when the
 * choreography finishes. Reduce-motion swaps the whole sequence for a quick
 * plain crossfade with no particles.
 */
export function RevealMorph({
  selfieUri,
  artworkUrl,
  washColor,
  burstColors,
  onDone,
  testID = 'wtp-reveal',
}: RevealMorphProps) {
  const reduceMotion = useReduceMotion();
  const [showBurst, setShowBurst] = useState(false);

  const selfieScale = useSharedValue(1);
  const selfieOpacity = useSharedValue(1);
  const blurOpacity = useSharedValue(0);
  const washOpacity = useSharedValue(0);
  const flashOpacity = useSharedValue(0);
  const artworkOpacity = useSharedValue(0);
  const artworkScale = useSharedValue(0.86);

  // Hold the latest onDone without restarting the choreography if the parent
  // re-renders with a new closure.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (reduceMotion) {
      // Evolution flashes trigger photosensitivity — swap the strobe for a
      // single soft white bloom and a plain crossfade.
      blurOpacity.value = 1;
      washOpacity.value = 0.22;
      selfieOpacity.value = withDelay(200, withTiming(0, { duration: 220 }));
      flashOpacity.value = withSequence(
        withTiming(0.7, { duration: 220, easing: Easing.out(Easing.ease) }),
        withTiming(0, { duration: 420, easing: Easing.out(Easing.cubic) }),
      );
      artworkOpacity.value = withDelay(220, withTiming(1, { duration: 300 }));
      artworkScale.value = withDelay(220, withTiming(1, { duration: 300 }));
      const doneTimer = setTimeout(() => onDoneRef.current(), REDUCED_DONE_MS);
      return () => {
        clearTimeout(doneTimer);
        cancelAnimation(selfieOpacity);
        cancelAnimation(flashOpacity);
        cancelAnimation(artworkOpacity);
        cancelAnimation(artworkScale);
      };
    }

    // 1. Dark stage + palette aura settle in fast; the form charges (scales up)
    //    through the whole strobe.
    blurOpacity.value = withTiming(1, { duration: 460, easing: Easing.out(Easing.ease) });
    washOpacity.value = withTiming(0.24, { duration: 500, easing: Easing.out(Easing.ease) });
    selfieScale.value = withTiming(1.1, {
      duration: SWAP_AT_MS,
      easing: Easing.inOut(Easing.quad),
    });

    // 2. Accelerating white strobe → full white-out. Peaks ramp so the selfie is
    //    still glimpsed between early flashes, then the light swallows it.
    const strobe = STROBE_PULSES.flatMap(([up, down], i) => [
      withTiming(STROBE_PEAKS[i], { duration: up, easing: Easing.out(Easing.ease) }),
      withTiming(0, { duration: down, easing: Easing.in(Easing.ease) }),
    ]);
    flashOpacity.value = withSequence(
      ...strobe,
      withTiming(1, { duration: WHITEOUT_UP_MS, easing: Easing.out(Easing.ease) }),
      withDelay(
        WHITEOUT_HOLD_MS,
        withTiming(0, { duration: WHITEOUT_DOWN_MS, easing: Easing.out(Easing.cubic) }),
      ),
    );

    // 3. The form swaps under the full white-out: selfie flickers off, the
    //    Pokémon flickers in, then blooms out as the light recedes.
    selfieOpacity.value = withDelay(SWAP_AT_MS, withTiming(0, { duration: 40 }));
    artworkOpacity.value = withDelay(SWAP_AT_MS - 40, withTiming(1, { duration: 60 }));
    artworkScale.value = withDelay(
      SWAP_AT_MS + WHITEOUT_HOLD_MS,
      withSequence(
        withTiming(1.08, { duration: 360, easing: Easing.out(Easing.cubic) }),
        withTiming(1, { duration: 260, easing: Easing.inOut(Easing.ease) }),
      ),
    );

    const burstTimer = setTimeout(() => setShowBurst(true), BURST_AT_MS);
    const doneTimer = setTimeout(() => onDoneRef.current(), MORPH_DONE_MS);
    return () => {
      clearTimeout(burstTimer);
      clearTimeout(doneTimer);
      cancelAnimation(selfieScale);
      cancelAnimation(selfieOpacity);
      cancelAnimation(blurOpacity);
      cancelAnimation(washOpacity);
      cancelAnimation(flashOpacity);
      cancelAnimation(artworkOpacity);
      cancelAnimation(artworkScale);
    };
    // Play once per mount — the parent re-keys this component to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  const selfieStyle = useAnimatedStyle(() => ({
    opacity: selfieOpacity.value,
    transform: [{ scale: selfieScale.value }],
  }));
  const flashStyle = useAnimatedStyle(() => ({
    opacity: flashOpacity.value,
  }));
  const blurStyle = useAnimatedStyle(() => ({
    opacity: blurOpacity.value,
  }));
  const washStyle = useAnimatedStyle(() => ({
    opacity: washOpacity.value,
  }));
  const artworkStyle = useAnimatedStyle(() => ({
    opacity: artworkOpacity.value,
    transform: [{ scale: artworkScale.value }],
  }));

  const burstPalette = burstColors.length > 0 ? burstColors : [washColor];

  return (
    <View style={styles.root} testID={testID}>
      {selfieUri ? (
        <Animated.View style={[StyleSheet.absoluteFillObject, selfieStyle]}>
          <SelfieImage
            cachePolicy="memory-disk"
            contentFit="cover"
            style={StyleSheet.absoluteFillObject}
            uri={selfieUri}
          />
        </Animated.View>
      ) : null}

      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, blurStyle]}>
        <BlurView intensity={55} style={StyleSheet.absoluteFillObject} tint="dark" />
      </Animated.View>

      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, { backgroundColor: washColor }, washStyle]}
        testID={`${testID}-wash`}
      />

      <View pointerEvents="none" style={styles.artworkLayer}>
        <Animated.View style={artworkStyle}>
          <CachedImage
            cachePolicy="disk"
            contentFit="contain"
            style={styles.artwork}
            testID={`${testID}-artwork`}
            uri={artworkUrl}
          />
        </Animated.View>
      </View>

      {/* Evolution white strobe — flickers over both forms, then blows out and
          recedes to reveal the Pokémon. Sits above the artwork so the swap
          happens hidden under the light. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, styles.flash, flashStyle]}
        testID={`${testID}-flash`}
      />

      <View pointerEvents="none" style={styles.artworkLayer}>
        {showBurst && !reduceMotion ? (
          <View pointerEvents="none" style={styles.burstLayer}>
            {Array.from({ length: PARTICLE_COUNT }, (_, index) => (
              <BurstParticle
                color={burstPalette[index % burstPalette.length]}
                index={index}
                key={index}
              />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.scannerCanvas,
    flex: 1,
  },
  artworkLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artwork: {
    height: '58%',
    width: '80%',
  },
  flash: {
    backgroundColor: '#ffffff',
  },
  burstLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  particle: {
    left: '50%',
    position: 'absolute',
    top: '50%',
  },
});

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

const isTestEnv = process.env.NODE_ENV === 'test';

// Total morph runtime before onDone fires. Shortened under jest so screen tests
// can walk capture → scanning → reveal → result on real timers.
const MORPH_DONE_MS = isTestEnv ? 40 : 2600;
const REDUCED_DONE_MS = isTestEnv ? 40 : 900;
const ARTWORK_DELAY_MS = 700;
const PARTICLE_COUNT = 10;

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
  const blurOpacity = useSharedValue(0);
  const washOpacity = useSharedValue(0);
  const artworkOpacity = useSharedValue(0);
  const artworkScale = useSharedValue(0.92);

  // Hold the latest onDone without restarting the choreography if the parent
  // re-renders with a new closure.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (reduceMotion) {
      blurOpacity.value = 1;
      washOpacity.value = 0.25;
      artworkOpacity.value = withTiming(1, { duration: 240 });
      artworkScale.value = 1;
      const doneTimer = setTimeout(() => onDoneRef.current(), REDUCED_DONE_MS);
      return () => {
        clearTimeout(doneTimer);
        cancelAnimation(artworkOpacity);
      };
    }

    selfieScale.value = withTiming(1.06, {
      duration: 900,
      easing: Easing.out(Easing.cubic),
    });
    blurOpacity.value = withTiming(1, { duration: 650, easing: Easing.out(Easing.ease) });
    // Wash floods to ~0.55 as the selfie dissolves, then relaxes so the artwork
    // reads clearly once it lands.
    washOpacity.value = withSequence(
      withTiming(0.55, { duration: 650, easing: Easing.out(Easing.ease) }),
      withDelay(350, withTiming(0.18, { duration: 600, easing: Easing.inOut(Easing.ease) })),
    );
    artworkOpacity.value = withDelay(
      ARTWORK_DELAY_MS,
      withTiming(1, { duration: 650, easing: Easing.out(Easing.cubic) }),
    );
    artworkScale.value = withDelay(
      ARTWORK_DELAY_MS,
      withSequence(
        withTiming(1.05, { duration: 420, easing: Easing.out(Easing.cubic) }),
        withTiming(1, { duration: 260, easing: Easing.inOut(Easing.ease) }),
      ),
    );

    const burstTimer = setTimeout(() => setShowBurst(true), ARTWORK_DELAY_MS);
    const doneTimer = setTimeout(() => onDoneRef.current(), MORPH_DONE_MS);
    return () => {
      clearTimeout(burstTimer);
      clearTimeout(doneTimer);
      cancelAnimation(selfieScale);
      cancelAnimation(blurOpacity);
      cancelAnimation(washOpacity);
      cancelAnimation(artworkOpacity);
      cancelAnimation(artworkScale);
    };
    // Play once per mount — the parent re-keys this component to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  const selfieStyle = useAnimatedStyle(() => ({
    transform: [{ scale: selfieScale.value }],
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
          <CachedImage
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

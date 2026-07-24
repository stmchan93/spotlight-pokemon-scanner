import { BlurView } from 'expo-blur';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { colors, radii } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';

import { useReduceMotion } from '../use-reduce-motion';
import { SelfieImage } from './selfie-image';

const isTestEnv = process.env.NODE_ENV === 'test';

// One loop: hold on you → dissolve to the Pokémon → hold → dissolve back.
const HOLD_SELFIE_MS = 900;
const MORPH_MS = 1150;
const HOLD_ARTWORK_MS = 1300;

type MorphLoopProps = {
  /** Local uri of the captured photo (the "before"). */
  selfieUri: string | null;
  /**
   * Background-removed selfie (data URI, PNG with alpha). When present the
   * morph gets the full outline arc: the background falls away leaving YOU,
   * a palette glow blooms around your silhouette, and your outline dissolves
   * into the Pokémon. Null → the original plain crossfade.
   */
  cutoutUri?: string | null;
  /** Official artwork of the matched species (the "after"). */
  artworkUrl: string;
  /** Top palette swatch — tints the dissolve wash at the crossfade midpoint. */
  washColor: string;
  testID?: string;
};

// Piecewise-linear ramp over t (worklet-safe; plain function of t.value).
function ramp(t: number, from: number, to: number): number {
  'worklet';
  if (to === from) {
    return t < from ? 0 : 1;
  }
  return Math.max(0, Math.min(1, (t - from) / (to - from)));
}

/**
 * A contained, auto-looping "how you transformed" animation for the result
 * screen: the captured photo dissolves (blur + palette wash + a slight zoom)
 * into the matched species' official artwork, holds, then dissolves back — on
 * a loop the user can just watch, no interaction. With a person cutout the
 * dissolve becomes an outline morph (background → silhouette glow → Pokémon).
 * Reduce-motion falls back to a static crossfade parked on the artwork.
 */
export function MorphLoop({
  selfieUri,
  cutoutUri = null,
  artworkUrl,
  washColor,
  testID = 'wtp-morph-loop',
}: MorphLoopProps) {
  const reduceMotion = useReduceMotion();

  // t: 0 = fully the photo, 1 = fully the Pokémon artwork.
  const t = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion || isTestEnv) {
      t.value = 1;
      return;
    }
    t.value = withRepeat(
      withSequence(
        withTiming(0, { duration: HOLD_SELFIE_MS }),
        withTiming(1, { duration: MORPH_MS, easing: Easing.inOut(Easing.cubic) }),
        withTiming(1, { duration: HOLD_ARTWORK_MS }),
        withTiming(0, { duration: MORPH_MS, easing: Easing.inOut(Easing.cubic) }),
      ),
      -1,
    );
    return () => {
      cancelAnimation(t);
    };
  }, [reduceMotion, t]);

  const hasCutout = Boolean(cutoutUri);

  const selfieStyle = useAnimatedStyle(() => ({
    // Slight zoom as it dissolves so the morph reads as motion, not a cut.
    transform: [{ scale: 1 + 0.06 * t.value }],
  }));
  const artworkStyle = useAnimatedStyle(() => ({
    // Outline arc: the Pokémon emerges only after the silhouette phase.
    opacity: hasCutout ? ramp(t.value, 0.5, 0.85) : t.value,
    transform: [{ scale: interpolate(t.value, [0, 1], [0.9, 1]) }],
  }));
  // Blur + wash flare at the crossfade midpoint (t≈0.5) and fade at both ends.
  const midFlareStyle = useAnimatedStyle(() => ({
    opacity: Math.sin(Math.max(0, Math.min(1, t.value)) * Math.PI),
  }));
  const washStyle = useAnimatedStyle(() => ({
    opacity: Math.sin(Math.max(0, Math.min(1, t.value)) * Math.PI) * (hasCutout ? 0.3 : 0.5),
  }));

  // Outline arc, phase 1 (t 0→0.35): the background falls away to the dark
  // canvas while the cutout (you) stays lit — the "grab your outline" moment.
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: ramp(t.value, 0.05, 0.35),
  }));
  // Palette glow blooming from BEHIND your silhouette: the same cutout, tinted
  // and scaled up slightly, peaking through the middle of the morph.
  const glowStyle = useAnimatedStyle(() => ({
    opacity: ramp(t.value, 0.15, 0.45) * (1 - ramp(t.value, 0.6, 0.85)),
    transform: [{ scale: 1.07 + 0.05 * t.value }],
  }));
  // Phase 2 (t 0.45→0.8): your lit silhouette dissolves into the artwork.
  const cutoutStyle = useAnimatedStyle(() => ({
    opacity: 1 - ramp(t.value, 0.45, 0.8),
    transform: [{ scale: 1 + 0.06 * t.value }],
  }));

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

      {cutoutUri ? (
        <>
          {/* Background falls away → only your outline stays lit. */}
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFillObject,
              { backgroundColor: colors.scannerCanvas },
              backdropStyle,
            ]}
            testID={`${testID}-backdrop`}
          />
          {/* Palette glow blooming from behind your silhouette. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFillObject, glowStyle]}
            testID={`${testID}-glow`}
          >
            <SelfieImage
              cachePolicy="memory"
              contentFit="contain"
              style={StyleSheet.absoluteFillObject}
              tintColor={washColor}
              uri={cutoutUri}
            />
          </Animated.View>
          {/* You, cut out of the scene — dissolves into the Pokémon. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFillObject, cutoutStyle]}
            testID={`${testID}-cutout`}
          >
            <SelfieImage
              cachePolicy="memory"
              contentFit="contain"
              style={StyleSheet.absoluteFillObject}
              uri={cutoutUri}
            />
          </Animated.View>
        </>
      ) : null}

      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, midFlareStyle]}>
        <BlurView intensity={48} style={StyleSheet.absoluteFillObject} tint="dark" />
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    aspectRatio: 1,
    backgroundColor: colors.scannerCanvas,
    borderRadius: radii.xl,
    overflow: 'hidden',
    width: '100%',
  },
  artworkLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artwork: {
    height: '78%',
    width: '86%',
  },
});

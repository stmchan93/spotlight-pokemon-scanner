import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
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

// One loop: hold on you → transform → hold on the Pokémon → transform back.
const HOLD_SELFIE_MS = 850;
const MORPH_MS = 1800;
const HOLD_ARTWORK_MS = 1250;

/**
 * Phase boundaries on t (0 = you, 1 = the Pokémon).
 *
 * The whole trick is the MORPH beat: your silhouette and the species silhouette
 * are painted in the SAME palette color and occupy the SAME box, so the only
 * thing that changes across it is the outline. The eye reads that as one shape
 * becoming another. Crossfading a photo into artwork — which is what this used
 * to do — reads instead as two unrelated pictures stacked on top of each other,
 * because the colors, framing and subject all change at once.
 */
const SHAPE: readonly [number, number] = [0.12, 0.34]; // your photo drops to a flat silhouette
const MORPH: readonly [number, number] = [0.42, 0.62]; // your shape → the species' shape
const COLOR: readonly [number, number] = [0.66, 0.84]; // the species colors in, front and center

// Without a cutout there is no silhouette of YOU to morph from, so the sequence
// collapses to: the scene falls away → the species' shape rises out of the dark
// → it fills in. Still shape-first, and critically the photo is GONE before the
// artwork arrives instead of sitting behind its transparent background.
const MORPH_NO_CUTOUT: readonly [number, number] = [0.3, 0.55];

type MorphLoopProps = {
  /** Local uri of the captured photo (the "before"). */
  selfieUri: string | null;
  /**
   * Background-removed selfie (data URI, PNG with alpha). Used ONLY as the source
   * of your silhouette — it is never drawn as a photo. Showing the cutout as a
   * picture is what made the old morph look like two copies of the user stacked
   * on top of each other. Null → the shorter shape-only sequence.
   */
  cutoutUri?: string | null;
  /** Official artwork of the matched species (the "after"). */
  artworkUrl: string;
  /** Top palette swatch — both silhouettes are painted in it. */
  washColor: string;
  testID?: string;
};

/** Piecewise-linear ramp over t (worklet-safe; plain function of t.value). */
function ramp(t: number, range: readonly [number, number]): number {
  'worklet';
  const [from, to] = range;
  if (to === from) {
    return t < from ? 0 : 1;
  }
  return Math.max(0, Math.min(1, (t - from) / (to - from)));
}

/**
 * A contained, auto-looping "how you transformed" animation for the result
 * screen. Your photo loses its background, flattens into a silhouette, that
 * silhouette morphs into the matched species' silhouette, and the species
 * colors in — then it plays back the other way, on a loop you can just watch.
 *
 * Every layer after the opening shot lives in one shared subject box, so your
 * body and the Pokémon occupy the same space on screen. Reduce-motion parks it
 * on the finished artwork.
 */
export function MorphLoop({
  selfieUri,
  cutoutUri = null,
  artworkUrl,
  washColor,
  testID = 'wtp-morph-loop',
}: MorphLoopProps) {
  const reduceMotion = useReduceMotion();

  // t: 0 = fully you, 1 = fully the Pokémon.
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
  const speciesShapeIn = hasCutout ? MORPH : MORPH_NO_CUTOUT;

  // The opening shot: you, full-bleed. It fades out as your silhouette takes
  // over — the old version left it at full opacity for the whole loop, so the
  // artwork's transparent background showed the photo through it.
  const selfieStyle = useAnimatedStyle(() => ({
    opacity: 1 - ramp(t.value, SHAPE),
    transform: [{ scale: 1 + 0.06 * t.value }],
  }));

  // The dark stage the transformation happens on.
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: ramp(t.value, SHAPE),
  }));

  // Palette glow blooming from behind the subject, brightest across the morph.
  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.55 * ramp(t.value, SHAPE) * (1 - ramp(t.value, COLOR)),
    transform: [{ scale: 1.06 + 0.06 * t.value }],
  }));

  // Your silhouette — the first half of the shape morph. It comes straight out
  // of the photo; the background-removed PHOTO is never shown.
  const personShapeStyle = useAnimatedStyle(() => ({
    opacity: ramp(t.value, SHAPE) * (1 - ramp(t.value, MORPH)),
    transform: [{ scale: 1 - 0.04 * ramp(t.value, MORPH) }],
  }));

  // The species' silhouette — the second half. Same color, same box: only the
  // outline changes across this beat.
  const speciesShapeStyle = useAnimatedStyle(() => ({
    opacity: ramp(t.value, speciesShapeIn) * (1 - ramp(t.value, COLOR)),
    transform: [{ scale: 0.96 + 0.04 * ramp(t.value, speciesShapeIn) }],
  }));

  // The Pokémon arrives front and center: it colors in while easing up to full
  // size, so the last beat is the species landing rather than a flat fade.
  const artworkStyle = useAnimatedStyle(() => ({
    opacity: ramp(t.value, COLOR),
    transform: [{ scale: 0.94 + 0.06 * ramp(t.value, COLOR) }],
  }));

  // A soft palette flare at the moment the shape changes, so the swap lands as a
  // beat rather than a dissolve. Peaks between the two silhouettes.
  const flareStyle = useAnimatedStyle(() => {
    const [from, to] = speciesShapeIn;
    const mid = (from + to) / 2;
    const distance = Math.min(1, Math.abs(t.value - mid) / 0.22);
    return { opacity: 0.34 * (1 - distance) };
  });

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

      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFillObject,
          { backgroundColor: colors.scannerCanvas },
          backdropStyle,
        ]}
        testID={`${testID}-backdrop`}
      />

      {cutoutUri ? (
        <>
          <Animated.View
            pointerEvents="none"
            style={[styles.subject, glowStyle]}
            testID={`${testID}-glow`}
          >
            <SelfieImage
              cachePolicy="memory"
              contentFit="contain"
              style={styles.subjectImage}
              tintColor={washColor}
              uri={cutoutUri}
            />
          </Animated.View>

          <Animated.View
            pointerEvents="none"
            style={[styles.subject, personShapeStyle]}
            testID={`${testID}-person-shape`}
          >
            <SelfieImage
              cachePolicy="memory"
              contentFit="contain"
              style={styles.subjectImage}
              tintColor={washColor}
              uri={cutoutUri}
            />
          </Animated.View>
        </>
      ) : null}

      <Animated.View
        pointerEvents="none"
        style={[styles.subject, speciesShapeStyle]}
        testID={`${testID}-species-shape`}
      >
        <CachedImage
          cachePolicy="disk"
          contentFit="contain"
          style={styles.subjectImage}
          tintColor={washColor}
          uri={artworkUrl}
        />
      </Animated.View>

      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, { backgroundColor: washColor }, flareStyle]}
        testID={`${testID}-wash`}
      />

      <Animated.View pointerEvents="none" style={[styles.subject, artworkStyle]}>
        <CachedImage
          cachePolicy="disk"
          contentFit="contain"
          style={styles.subjectImage}
          testID={`${testID}-artwork`}
          uri={artworkUrl}
        />
      </Animated.View>
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
  // One box for every "subject" layer — your cutout, both silhouettes and the
  // artwork — so the transformation happens in place instead of the person and
  // the Pokémon being drawn at different sizes in different parts of the frame.
  subject: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subjectImage: {
    height: '82%',
    width: '86%',
  },
});

import { BlurView } from 'expo-blur';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, useWindowDimensions, View } from 'react-native';
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

import type { NormalizedPoint } from '@spotlight/api-client';
import { colors } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';

import {
  resolveArtworkRect,
  REVEAL_ARTWORK_HEIGHT_PCT,
  REVEAL_ARTWORK_WIDTH_PCT,
} from '../face-geometry';
import { buildMorphOutlines, morphPathD, outlinePathD } from '../outline-morph';
import { useReduceMotion } from '../use-reduce-motion';
import { SelfieImage } from './selfie-image';

const isTestEnv = process.env.NODE_ENV === 'test';

const AnimatedPath = Animated.createAnimatedComponent(Path);

// THE BEAT
//
// This screen used to end on a hard cut: the selfie swapped for the artwork in
// 40ms, timed to the peak of a full-white flash. Nothing morphed — the flash was
// there to hide that there was no morph. It is gone.
//
// What plays now, when the backend traced both outlines:
//
//   0 .. RESOLVE      your photo drops away to a dark stage and resolves into
//                     YOUR silhouette, drawn as a filled path
//   .. + MORPH        that path continuously DEFORMS into the species' outline,
//                     point for point, in one shared box
//   .. + COLOR        the creature colours in out of its own silhouette
//
// The deformation gets the longest beat on purpose: it is the whole point of the
// screen. A palette bloom swells across it — soft, palette-tinted, never a
// white-out, and never covering the shape it is lit by.
/** Photo → dark stage → your outline. Skipped when the lock-on already did it. */
const RESOLVE_MS = 460;
/** Handoff settle when the lock-on already left your silhouette on screen. */
const HANDOFF_MS = 160;
/** The morph itself. */
const MORPH_MS = 1240;
/** The species colours in out of the silhouette. */
const COLOR_MS = 460;
/** Tail after the colour lands, before the result panel takes over. */
const SETTLE_MS = 260;

// Without YOUR outline there is nothing to deform FROM, so the sequence
// collapses to the honest version of itself: dark stage → the species
// silhouette rises → it colours in. Shape-first, no deceptive flash.
const SILHOUETTE_RISE_MS = 620;
const SILHOUETTE_HOLD_MS = 240;

const REDUCED_DONE_MS = isTestEnv ? 40 : 900;
const PARTICLE_COUNT = 14;

type RevealMorphProps = {
  /** Local uri of the selfie the morph resolves out of. */
  selfieUri: string | null;
  /** Official artwork of the matched species the morph resolves into. */
  artworkUrl: string;
  /** Top selfie palette swatch — paints the silhouette and the bloom. */
  washColor: string;
  /** Palette colors cycled across the particle burst. */
  burstColors: string[];
  /**
   * YOUR traced outline, normalized 0..1 against the person cutout. Absent →
   * the silhouette-rise fallback. Mirrored on projection, because the selfie is
   * flipped for display.
   */
  personOutline?: NormalizedPoint[] | null;
  /**
   * The species' traced outline, normalized 0..1 against the artwork PNG. Only
   * valid for the TOP match — the caller must not pass it for a promoted
   * alternate.
   */
  speciesOutline?: NormalizedPoint[] | null;
  /**
   * True when the lock-on already collapsed the scene onto the silhouette. The
   * reveal then opens on exactly that shape — same outlines, same rect, same
   * palette colour — instead of replaying the photo, so the handoff has no seam.
   */
  fromSilhouette?: boolean;
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
 * The reveal: your photo resolves into your own silhouette, that silhouette
 * deforms into the matched species' silhouette, and the species colours in.
 *
 * Both silhouettes are the SAME filled path — one palette colour, one box — so
 * across the middle beat the only thing changing on screen is the outline, which
 * is what makes the eye read it as one shape becoming another rather than as two
 * pictures being swapped.
 *
 * Calls `onDone` when the choreography finishes. Reduce-motion resolves straight
 * onto the artwork with no travel and no particles.
 */
export function RevealMorph({
  selfieUri,
  artworkUrl,
  washColor,
  burstColors,
  personOutline = null,
  speciesOutline = null,
  fromSilhouette = false,
  onDone,
  testID = 'wtp-reveal',
}: RevealMorphProps) {
  const reduceMotion = useReduceMotion();
  const [showBurst, setShowBurst] = useState(false);

  // Start from the window (correct on this full-bleed route, and available on
  // the first frame) and switch to the measured box if it turns out smaller.
  // The lock-on resolves its geometry exactly the same way, which is what keeps
  // the handoff shape in place.
  const screenSize = useWindowDimensions();
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setMeasured((current) => {
      if (width <= 0 || height <= 0) {
        return current;
      }
      if (current && current.width === width && current.height === height) {
        return current;
      }
      return { width, height };
    });
  }, []);
  const containerWidth = measured?.width ?? screenSize.width;
  const containerHeight = measured?.height ?? screenSize.height;

  const morph = useMemo(() => {
    const artworkRect = resolveArtworkRect(containerWidth, containerHeight);
    return buildMorphOutlines({ personOutline, speciesOutline, artworkRect });
  }, [containerHeight, containerWidth, personOutline, speciesOutline]);
  const canMorph = morph.canMorph;

  const stageOpacity = useSharedValue(fromSilhouette ? 1 : 0);
  const selfieOpacity = useSharedValue(1);
  const shapeOpacity = useSharedValue(fromSilhouette ? 1 : 0);
  const shapeProgress = useSharedValue(0);
  const bloomOpacity = useSharedValue(0);
  const artworkOpacity = useSharedValue(0);
  // ONE scale for the silhouette AND the artwork. Both are centred on the same
  // point, so a shared scale keeps them registered on top of each other through
  // the colour-in — scaling only the artwork would make it drift off the shape
  // it is supposed to be emerging from.
  const subjectScale = useSharedValue(1);

  // Hold the latest onDone without restarting the choreography if the parent
  // re-renders with a new closure.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const cancelAll = () => {
      cancelAnimation(stageOpacity);
      cancelAnimation(selfieOpacity);
      cancelAnimation(shapeOpacity);
      cancelAnimation(shapeProgress);
      cancelAnimation(bloomOpacity);
      cancelAnimation(artworkOpacity);
      cancelAnimation(subjectScale);
    };

    if (reduceMotion) {
      // Motion-free resolve: no travel, no deformation, no particles. The shape
      // is parked on its END state so nothing appears to move under someone who
      // asked for less movement.
      stageOpacity.value = 1;
      shapeProgress.value = 1;
      shapeOpacity.value = withTiming(0, { duration: 260 });
      selfieOpacity.value = withTiming(0, { duration: 220 });
      bloomOpacity.value = withSequence(
        withTiming(0.22, { duration: 200 }),
        withTiming(0, { duration: 380 }),
      );
      artworkOpacity.value = withDelay(160, withTiming(1, { duration: 300 }));
      const doneTimer = setTimeout(() => onDoneRef.current(), REDUCED_DONE_MS);
      return () => {
        clearTimeout(doneTimer);
        cancelAll();
      };
    }

    // Beat 1 — the photo falls away to a dark stage and the silhouette resolves.
    // When the lock-on handed off, the shape is already on screen at full
    // opacity and this beat is just a short settle.
    const resolveMs = fromSilhouette ? HANDOFF_MS : RESOLVE_MS;
    stageOpacity.value = withTiming(1, {
      duration: Math.max(220, resolveMs),
      easing: Easing.out(Easing.ease),
    });
    selfieOpacity.value = withTiming(0, {
      duration: Math.max(220, resolveMs),
      easing: Easing.out(Easing.ease),
    });
    // Beat 2 — the deformation. Slow in, slow out, no cut anywhere in it.
    const morphMs = canMorph ? MORPH_MS : SILHOUETTE_RISE_MS + SILHOUETTE_HOLD_MS;
    const colorAtMs = resolveMs + morphMs;

    // The silhouette's whole life in ONE assignment: rise, hold through the
    // deformation, fade out under the colour. Splitting it across two writes to
    // the same shared value would silently cancel the rise — the second write
    // replaces the running animation rather than queueing behind it.
    const riseDelayMs = canMorph ? 0 : Math.round(resolveMs * 0.5);
    const riseMs = canMorph ? resolveMs : SILHOUETTE_RISE_MS;
    const shapeOutAtMs = colorAtMs + COLOR_MS * 0.5;
    shapeOpacity.value = withSequence(
      withDelay(riseDelayMs, withTiming(1, { duration: riseMs })),
      withDelay(
        Math.max(0, shapeOutAtMs - riseDelayMs - riseMs),
        withTiming(0, { duration: COLOR_MS * 0.6 }),
      ),
    );

    if (canMorph) {
      shapeProgress.value = withDelay(
        resolveMs,
        withTiming(1, { duration: MORPH_MS, easing: Easing.inOut(Easing.cubic) }),
      );
    } else {
      // No outline for you → nothing to deform from; the species silhouette
      // simply rises. Still shape-first, and still no flash.
      shapeProgress.value = 1;
    }

    // A palette bloom across the shape change. It sits BEHIND the silhouette and
    // tops out at 0.24, so it lights the stage in your own colour without ever
    // covering the thing it is lighting. The old full-white version was in front
    // and peaked at 1.0 — the only thing it lit was the swap it was hiding.
    bloomOpacity.value = withDelay(
      Math.round(resolveMs + morphMs * 0.3),
      withSequence(
        withTiming(0.24, { duration: morphMs * 0.5, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.08, { duration: COLOR_MS, easing: Easing.out(Easing.cubic) }),
        withTiming(0, { duration: SETTLE_MS }),
      ),
    );

    // Beat 3 — the species colours in out of its own silhouette. The shape holds
    // underneath while the artwork rises over it, so the fill never blinks.
    artworkOpacity.value = withDelay(
      colorAtMs,
      withTiming(1, { duration: COLOR_MS, easing: Easing.out(Easing.ease) }),
    );
    // The landing: shape and artwork breathe together, so the moment reads as
    // the creature arriving rather than as a picture being scaled into place.
    subjectScale.value = withDelay(
      colorAtMs,
      withSequence(
        withTiming(1.04, { duration: COLOR_MS, easing: Easing.out(Easing.cubic) }),
        withTiming(1, { duration: SETTLE_MS, easing: Easing.inOut(Easing.ease) }),
      ),
    );

    const doneMs = colorAtMs + COLOR_MS + SETTLE_MS;
    const burstTimer = setTimeout(() => setShowBurst(true), colorAtMs + 40);
    // Shortened under jest so screen tests can walk capture → scanning →
    // lock-on → reveal → result on real timers. Every layer still mounts.
    const doneTimer = setTimeout(() => onDoneRef.current(), isTestEnv ? 40 : doneMs);
    return () => {
      clearTimeout(burstTimer);
      clearTimeout(doneTimer);
      cancelAll();
    };
    // Play once per mount — the parent re-keys this component to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canMorph, fromSilhouette, reduceMotion]);

  const selfieStyle = useAnimatedStyle(() => ({ opacity: selfieOpacity.value }));
  const stageStyle = useAnimatedStyle(() => ({ opacity: stageOpacity.value }));
  const bloomStyle = useAnimatedStyle(() => ({ opacity: bloomOpacity.value }));
  const shapeStyle = useAnimatedStyle(() => ({
    opacity: shapeOpacity.value,
    transform: [{ scale: subjectScale.value }],
  }));
  const artworkStyle = useAnimatedStyle(() => ({
    opacity: artworkOpacity.value,
    transform: [{ scale: subjectScale.value }],
  }));

  // The deformation itself: one closed path re-evaluated every frame between
  // the two traced outlines. `morphPathD` and everything it calls are worklets.
  const morphFrom = morph.from;
  const morphTo = morph.to;
  const shapePathProps = useAnimatedProps(() => ({
    d: morphPathD(morphFrom, morphTo, shapeProgress.value),
  }));
  // First-frame `d`, so the shape is already YOUR outline before the UI thread
  // takes the prop over — the same static path the lock-on ended on. Mirrors
  // HeartToggle, which also hands its AnimatedPath a plain `d`.
  const openingShapePath = useMemo(() => outlinePathD(morphFrom), [morphFrom]);

  const burstPalette = burstColors.length > 0 ? burstColors : [washColor];

  return (
    <View onLayout={handleLayout} style={styles.root} testID={testID}>
      {fromSilhouette || !selfieUri ? null : (
        <Animated.View
          style={[StyleSheet.absoluteFillObject, selfieStyle]}
          testID={`${testID}-selfie`}
        >
          <SelfieImage
            cachePolicy="memory-disk"
            contentFit="cover"
            style={StyleSheet.absoluteFillObject}
            uri={selfieUri}
          />
          <BlurView intensity={55} style={StyleSheet.absoluteFillObject} tint="dark" />
        </Animated.View>
      )}

      {/* The dark stage the transformation happens on. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, styles.stage, stageStyle]}
        testID={`${testID}-stage`}
      />

      {/* Palette bloom — a swell of the selfie's own colour across the shape
          change. Deliberately NOT a white-out, and deliberately BEHIND the
          silhouette: it lights the morph, it does not hide it. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, { backgroundColor: washColor }, bloomStyle]}
        testID={`${testID}-bloom`}
      />

      {canMorph ? (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFillObject, shapeStyle]}
          testID={`${testID}-shape`}
        >
          <Svg height={containerHeight} width={containerWidth}>
            <AnimatedPath
              animatedProps={shapePathProps}
              d={openingShapePath}
              fill={washColor}
              testID={`${testID}-shape-path`}
            />
          </Svg>
        </Animated.View>
      ) : (
        <Animated.View pointerEvents="none" style={[styles.artworkLayer, shapeStyle]}>
          <CachedImage
            cachePolicy="disk"
            contentFit="contain"
            style={styles.artwork}
            testID={`${testID}-silhouette`}
            tintColor={washColor}
            uri={artworkUrl}
          />
        </Animated.View>
      )}

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
  stage: {
    backgroundColor: colors.scannerCanvas,
  },
  artworkLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Shared with the lock-on silhouette via face-geometry's REVEAL_ARTWORK_BOX,
  // so the shape does not jump on handoff.
  artwork: {
    height: REVEAL_ARTWORK_HEIGHT_PCT,
    width: REVEAL_ARTWORK_WIDTH_PCT,
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

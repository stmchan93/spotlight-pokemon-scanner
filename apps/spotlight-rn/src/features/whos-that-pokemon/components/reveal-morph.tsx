import { BlurView } from 'expo-blur';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
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
import { buildRevealHapticScore, scheduleEvolutionHaptics } from '../evolution-haptics';
import { buildMorphOutlines, morphPathD, outlinePathD } from '../outline-morph';
import { useReduceMotionState } from '../use-reduce-motion';
import { SelfieImage } from './selfie-image';

const isTestEnv = process.env.NODE_ENV === 'test';

const AnimatedPath = Animated.createAnimatedComponent(Path);

// THE BEAT
//
// This screen used to end on a hard cut: the selfie swapped for the artwork in
// 40ms, timed to the peak of a full-white flash. Nothing morphed — the flash was
// there to hide that there was no morph.
//
// What plays now, when the backend traced both outlines:
//
//   0 .. RESOLVE      your photo drops away to a dark stage and resolves into
//                     YOUR silhouette, drawn as a filled path
//   .. + BUILD        that path DEFORMS into the species' outline while a white
//                     glow pulses through it — five pulses, each one arriving
//                     sooner and burning brighter than the last, with the shape
//                     swelling and stretching on every one
//   .. + SWELL        the pulses stop resolving back down and the glow simply
//                     climbs, white-hot, into
//   .. + FLASH        one bright flash: the moment of becoming
//   .. + LAND         the creature colours in out of that flash, overshoots,
//                     settles, and is then held ALONE on screen before the
//                     result panel is allowed to take over
//
// THE ACCELERATION IS THE POINT. A long beat at a constant tempo just feels
// slow; the same duration with a rising tempo feels like something is coming.
// The build is deliberately close to twice its old length (4.2s vs 2.2s) because
// anticipation is the thing this screen sells, but every millisecond of that
// extra time is spent getting FASTER.
//
// AND IT IS NOT A STROBE. The pulses top out at 1.85Hz (the tightest cycle is
// 540ms) against a partial-screen shape at 70% white — nowhere near the ~3Hz
// high-contrast threshold that matters for photosensitivity. There is exactly
// ONE full-frame flash in the whole beat, it happens once, and it never repeats.

/** Photo → dark stage → your outline. Skipped when the lock-on already did it. */
const RESOLVE_MS = 460;
/** Handoff settle when the lock-on already left your silhouette on screen. */
const HANDOFF_MS = 160;

/**
 * The pulse tempo curve — one entry per pulse, each the full period of that
 * pulse (rise + fall) in ms. Read it as a metronome speeding up:
 *
 *   1000ms → 850 → 720 → 620 → 540      (1.00Hz → 1.85Hz)
 *
 * The floor is the slowest thing that still reads as a pulse rather than as a
 * fade; the ceiling is capped well under 3Hz on purpose (see above). Everything
 * faster than this is carried by the haptics, which have no such constraint.
 */
const PULSE_CYCLES_MS = [1000, 850, 720, 620, 540] as const;
/** Each pulse burns brighter than the last, so the build reads as a build. */
const PULSE_PEAKS = [0.26, 0.36, 0.47, 0.58, 0.7] as const;
/** Fast in, slow out — a heartbeat, not a sine wave. */
const PULSE_RISE_RATIO = 0.3;
/** Pulses fall back to a faint ember rather than to nothing. */
const PULSE_FLOOR = 0.06;
/**
 * After the last pulse the glow stops cycling and simply climbs to white. This
 * is what keeps the end of the accelerando from becoming a strobe: the final
 * approach has NO off-on transition in it at all, just one continuous rise.
 */
const SWELL_MS = 470;

const PULSE_PHASE_MS = PULSE_CYCLES_MS.reduce((total, cycle) => total + cycle, 0);
/** The deformation's full length: the pulse train plus the closing swell. */
const MORPH_MS = PULSE_PHASE_MS + SWELL_MS;

/** When each pulse peaks, relative to the start of the morph. */
function pulsePeakTimes(): number[] {
  const peaks: number[] = [];
  let cursor = 0;
  for (const cycle of PULSE_CYCLES_MS) {
    peaks.push(cursor + Math.round(cycle * PULSE_RISE_RATIO));
    cursor += cycle;
  }
  return peaks;
}
const PULSE_PEAK_AT_MS = pulsePeakTimes();

/**
 * The haptic-only run-up, measured from the start of the closing swell.
 *
 * Nothing discrete happens on screen here — the glow is mid-climb — so this is
 * the one place the two channels diverge, and it is safe to: 140ms/110ms/90ms
 * spacing would be unacceptable as light, and is a snare roll as touch.
 */
const ROLL_OFFSET_MS = [130, 270, 380] as const;

/** The flash: rises INTO the moment of becoming, then decays. Happens once. */
const FLASH_IN_MS = 140;
const FLASH_OUT_MS = 420;
const FLASH_PEAK = 0.85;

/** The species colours in out of the flash. */
const COLOR_MS = 640;
/** Overshoot — the creature arrives with weight rather than fading up. */
const IMPACT_MS = 380;
/** …and settles back. */
const SETTLE_MS = 460;
const LAND_MS = Math.max(COLOR_MS, IMPACT_MS + SETTLE_MS);
/**
 * THE HELD BEAT. Once it has landed, the creature gets the screen to itself
 * before the result panel slides in. Cutting straight to the panel throws away
 * the payoff the entire build was for — you have to actually SEE the thing.
 */
const HOLD_ALONE_MS = 900;

// Without YOUR outline there is nothing to deform FROM, so the sequence
// collapses to the honest version of itself: dark stage → the species
// silhouette rises → it colours in. Shape-first, no deceptive flash. It still
// gets a glow, a flash and a landing, but no pulse train — there is no
// transformation to build anticipation for, and this path is also what a
// promoted alternate replays, which should stay snappy.
const SILHOUETTE_RISE_MS = 620;
const SILHOUETTE_HOLD_MS = 240;
const HOLD_ALONE_SHORT_MS = 520;

/**
 * Reduce motion: no deformation, no pulses, no flash — a calm cross-fade at a
 * SENSIBLE length. Deliberately NOT scaled up alongside the longer build; a
 * stretched-out version of an effect someone asked not to see is worse than the
 * short one. Long enough to register the creature, and nothing more.
 */
const REDUCED_DONE_MS = isTestEnv ? 40 : 1100;
const REDUCED_LAND_AT_MS = isTestEnv ? 10 : 420;

/**
 * Haptics run on their own clock under jest.
 *
 * The visual timings above are NOT compressed for tests (reanimated is mocked,
 * so they cost nothing), but the haptic score is real `setTimeout` work and a
 * test should not have to wait six seconds to observe the rhythm.
 */
const HAPTIC_TIME_SCALE = isTestEnv ? 0.01 : 1;

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
  /** Fired once the morph has fully played AND the creature has been held. */
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
 * pulses white and deforms into the matched species', and the species colours in
 * out of a single flash and is held.
 *
 * Both silhouettes are the SAME filled path — one palette colour, one box — so
 * across the middle beat the only thing changing on screen is the outline, which
 * is what makes the eye read it as one shape becoming another rather than as two
 * pictures being swapped. The white glow rides on top of that same path, so the
 * thing that is glowing is provably the thing that is transforming.
 *
 * Calls `onDone` when the choreography finishes. Reduce-motion resolves straight
 * onto the artwork with no travel, no pulse, no flash and no particles.
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
  const { isResolved: isMotionPreferenceKnown, reduceMotion } = useReduceMotionState();
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

  /**
   * Every moment in the beat, in one place — the animation and the haptic score
   * are both derived from it, which is what stops the rhythm drifting out of
   * sync with what is on screen.
   */
  const timeline = useMemo(() => {
    // The lock-on already collapsed the scene onto the silhouette when it hands
    // off, so there is nothing to resolve — just a settle.
    const resolveMs = fromSilhouette ? HANDOFF_MS : RESOLVE_MS;
    const morphMs = canMorph ? MORPH_MS : SILHOUETTE_RISE_MS + SILHOUETTE_HOLD_MS;
    const colorAtMs = resolveMs + morphMs;
    return {
      resolveMs,
      morphMs,
      colorAtMs,
      landAtMs: colorAtMs + LAND_MS,
      holdAloneMs: canMorph ? HOLD_ALONE_MS : HOLD_ALONE_SHORT_MS,
    };
  }, [canMorph, fromSilhouette]);

  const stageOpacity = useSharedValue(fromSilhouette ? 1 : 0);
  const selfieOpacity = useSharedValue(1);
  const shapeOpacity = useSharedValue(fromSilhouette ? 1 : 0);
  const shapeProgress = useSharedValue(0);
  const bloomOpacity = useSharedValue(0);
  const artworkOpacity = useSharedValue(0);
  /** White glow riding on the silhouette. 0..1, pulsing then climbing. */
  const pulse = useSharedValue(0);
  /** How much of the pulse is allowed to distort the shape. Grows, then unwinds. */
  const swell = useSharedValue(0);
  /** The single flash. Never repeats. */
  const flash = useSharedValue(0);
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
      cancelAnimation(pulse);
      cancelAnimation(swell);
      cancelAnimation(flash);
      cancelAnimation(subjectScale);
    };

    if (reduceMotion) {
      // Motion-free resolve: no travel, no deformation, no pulse, no flash, no
      // particles. The shape is parked on its END state so nothing appears to
      // move under someone who asked for less movement.
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
    const { colorAtMs, landAtMs, holdAloneMs, morphMs, resolveMs } = timeline;
    stageOpacity.value = withTiming(1, {
      duration: Math.max(220, resolveMs),
      easing: Easing.out(Easing.ease),
    });
    selfieOpacity.value = withTiming(0, {
      duration: Math.max(220, resolveMs),
      easing: Easing.out(Easing.ease),
    });
    // Beat 2 — the deformation. Slow in, slow out, no cut anywhere in it.
    //
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
      // simply rises.
      shapeProgress.value = 1;
    }

    // THE PULSE TRAIN. Each cycle is a fast rise to a brighter peak and a slower
    // fall back to an ember, and the cycles get shorter as they go. After the
    // last one the glow stops cycling and climbs, uninterrupted, to white — so
    // the fastest thing in the beat is a RAMP, not a flicker.
    if (canMorph) {
      const pulseSteps: number[] = [];
      PULSE_CYCLES_MS.forEach((cycle, index) => {
        const riseInMs = Math.round(cycle * PULSE_RISE_RATIO);
        pulseSteps.push(
          withTiming(PULSE_PEAKS[index], {
            duration: riseInMs,
            easing: Easing.out(Easing.quad),
          }),
        );
        pulseSteps.push(
          withTiming(PULSE_FLOOR, {
            duration: cycle - riseInMs,
            easing: Easing.in(Easing.quad),
          }),
        );
      });
      pulseSteps.push(withTiming(1, { duration: SWELL_MS, easing: Easing.in(Easing.quad) }));
      pulseSteps.push(withTiming(0, { duration: FLASH_OUT_MS, easing: Easing.out(Easing.cubic) }));
      pulse.value = withDelay(resolveMs, withSequence(...pulseSteps));
    } else {
      // One slow swell instead of a train — there is no deformation here to
      // punctuate, and a compressed pulse train would be a flicker.
      const swellInMs = Math.round(morphMs * 0.6);
      pulse.value = withDelay(
        resolveMs,
        withSequence(
          withTiming(0.5, { duration: swellInMs, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: morphMs - swellInMs, easing: Easing.in(Easing.quad) }),
          withTiming(0, { duration: FLASH_OUT_MS, easing: Easing.out(Easing.cubic) }),
        ),
      );
    }

    // Squash-and-stretch amplitude. It GROWS across the pulse train, so each
    // pulse throws the shape around a little harder than the last, then unwinds
    // to zero across the closing swell — the shape settles into its true
    // proportions at the exact moment it whites out.
    const swellUpMs = canMorph ? PULSE_PHASE_MS : Math.round(morphMs * 0.6);
    swell.value = withDelay(
      resolveMs,
      withSequence(
        withTiming(1, { duration: swellUpMs, easing: Easing.in(Easing.quad) }),
        withTiming(0, { duration: Math.max(1, morphMs - swellUpMs), easing: Easing.out(Easing.cubic) }),
      ),
    );

    // THE FLASH. One, brief, and it lands AFTER a real 4.2s deformation rather
    // than instead of one — which is the difference between this and the
    // full-white cut that used to live here. It is the punctuation on a
    // transformation the user has already watched happen, not a cover for a swap.
    flash.value = withDelay(
      Math.max(0, colorAtMs - FLASH_IN_MS),
      withSequence(
        withTiming(FLASH_PEAK, { duration: FLASH_IN_MS, easing: Easing.in(Easing.quad) }),
        withTiming(0, { duration: FLASH_OUT_MS, easing: Easing.out(Easing.cubic) }),
      ),
    );

    // A palette bloom across the shape change. It sits BEHIND the silhouette and
    // tops out at 0.24, so it lights the stage in your own colour without ever
    // covering the thing it is lighting.
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
    // The landing: an overshoot and a settle, so the creature ARRIVES rather
    // than fading up. Shape and artwork share the scale, so they stay registered
    // through the cross-over.
    subjectScale.value = withDelay(
      colorAtMs,
      withSequence(
        withTiming(1.07, { duration: IMPACT_MS, easing: Easing.out(Easing.cubic) }),
        withTiming(1, { duration: SETTLE_MS, easing: Easing.inOut(Easing.ease) }),
      ),
    );

    // …and then the creature is simply held there.
    const doneMs = landAtMs + holdAloneMs;
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

  /**
   * The soundtrack, in its own effect.
   *
   * Every beat is pinned to a moment that is ALREADY VISIBLE — a pulse peak, the
   * flash, the landing — so a device with no taptic engine, an OEM that ignores
   * it, or a user with system haptics off loses the rhythm and nothing else. The
   * visual beat is complete on its own; this is the layer on top.
   *
   * Gated on `isMotionPreferenceKnown` because the OS preference arrives
   * asynchronously: cancelling an animation the user never saw is free,
   * cancelling a buzz they already felt is not.
   */
  useEffect(() => {
    if (!isMotionPreferenceKnown) {
      return;
    }
    const { colorAtMs, landAtMs, morphMs, resolveMs } = timeline;
    const score = buildRevealHapticScore({
      // Reduce motion collapses this to a single release tap; the peaks and the
      // roll are discarded inside `buildRevealHapticScore`.
      peaksMs: canMorph
        ? PULSE_PEAK_AT_MS.map((at) => resolveMs + at)
        : [resolveMs + Math.round(morphMs * 0.25), resolveMs + Math.round(morphMs * 0.7)],
      rollMs: canMorph ? ROLL_OFFSET_MS.map((at) => resolveMs + PULSE_PHASE_MS + at) : [],
      climaxAtMs: reduceMotion ? REDUCED_LAND_AT_MS : colorAtMs,
      landAtMs: reduceMotion ? REDUCED_LAND_AT_MS : landAtMs,
      reduceMotion,
    });
    return scheduleEvolutionHaptics(score, { scale: HAPTIC_TIME_SCALE });
  }, [canMorph, isMotionPreferenceKnown, reduceMotion, timeline]);

  const selfieStyle = useAnimatedStyle(() => ({ opacity: selfieOpacity.value }));
  const stageStyle = useAnimatedStyle(() => ({ opacity: stageOpacity.value }));
  const bloomStyle = useAnimatedStyle(() => ({ opacity: bloomOpacity.value }));
  const flashStyle = useAnimatedStyle(() => ({ opacity: flash.value }));
  /** Nested inside the shape, so it inherits the shape's opacity and distortion. */
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  // Opacity and transform only — this all runs on the UI thread, which is what
  // keeps it honest on a mid-range Android.
  const shapeStyle = useAnimatedStyle(() => {
    const intensity = pulse.value * swell.value;
    return {
      opacity: shapeOpacity.value,
      transform: [
        { scale: subjectScale.value },
        // Stretch tall and pull narrow on every pulse: the silhouette strains
        // against its own outline, which is the thing that reads as "becoming".
        { scaleY: 1 + intensity * 0.1 },
        { scaleX: 1 - intensity * 0.05 },
      ],
    };
  });
  const artworkStyle = useAnimatedStyle(() => ({
    opacity: artworkOpacity.value,
    transform: [{ scale: subjectScale.value }],
  }));

  // The deformation itself: one closed path re-evaluated every frame between
  // the two traced outlines. `morphPathD` and everything it calls are worklets.
  // Built ONCE per frame and read by both the fill and the white glow riding on
  // it, so the glow is provably the same outline rather than a second drawing.
  const morphFrom = morph.from;
  const morphTo = morph.to;
  const shapePath = useDerivedValue(() => morphPathD(morphFrom, morphTo, shapeProgress.value));
  const shapePathProps = useAnimatedProps(() => ({ d: shapePath.value }));
  const pulsePathProps = useAnimatedProps(() => ({ d: shapePath.value }));
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
          change. Deliberately BEHIND the silhouette: it lights the morph, it
          does not hide it. */}
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
          {reduceMotion ? null : (
            <Animated.View
              pointerEvents="none"
              style={[StyleSheet.absoluteFillObject, pulseStyle]}
              testID={`${testID}-pulse`}
            >
              <Svg height={containerHeight} width={containerWidth}>
                <AnimatedPath
                  animatedProps={pulsePathProps}
                  d={openingShapePath}
                  fill={colors.scannerTextPrimary}
                  testID={`${testID}-pulse-path`}
                />
              </Svg>
            </Animated.View>
          )}
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
          {reduceMotion ? null : (
            <Animated.View
              pointerEvents="none"
              style={[styles.artworkLayer, pulseStyle]}
              testID={`${testID}-pulse`}
            >
              <CachedImage
                cachePolicy="disk"
                contentFit="contain"
                style={styles.artwork}
                tintColor={colors.scannerTextPrimary}
                uri={artworkUrl}
              />
            </Animated.View>
          )}
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

      {/* The moment of becoming. One flash, over everything, then gone. */}
      {reduceMotion ? null : (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFillObject, styles.flash, flashStyle]}
          testID={`${testID}-flash`}
        />
      )}

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
  flash: {
    backgroundColor: colors.scannerTextPrimary,
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

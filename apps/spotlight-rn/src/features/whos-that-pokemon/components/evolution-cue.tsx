import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText, colors, spacing, textStyles } from '@spotlight/design-system';

import { resolveArtworkRect } from '../face-geometry';
import { useReduceMotionState } from '../use-reduce-motion';
import { EVOLVING_LEAD, EVOLVING_TAIL } from '../evolution-copy';
import { scheduleEvolutionHaptics, type EvolutionHapticBeat } from '../evolution-haptics';

const isTestEnv = process.env.NODE_ENV === 'test';

// Jest walks capture → scanning → lock-on → EVOLVING → reveal → result on real
// timers, so this beat is compressed rather than skipped: the same layers mount
// and `onDone` still fires, it just resolves in ~40ms.
const TIME_SCALE = isTestEnv ? 0.02 : 1;
const ms = (value: number) => Math.max(1, Math.round(value * TIME_SCALE));

// Three words, three beats — the pause between them IS the joke.
const LEAD_AT_MS = 0;
const NAME_AT_MS = 620;
const TAIL_AT_MS = 1280;
const WORD_IN_MS = 340;
/** Time the finished line holds before the morph takes over. */
const HOLD_MS = 850;
/**
 * The line fades back out before the handoff.
 *
 * The lock-on's last frame and the reveal's first frame are the SAME silhouette
 * on the SAME dark stage — that identity is the whole seam-hiding trick, and a
 * caption that is present on one frame and gone on the next is a visible pop in
 * the middle of it. Fading it clears the stage before the reveal's pulse train
 * starts, which is also just better staging: the words hand over to the morph
 * rather than being cut off by it.
 *
 * Costs nothing: it is carved out of the hold this beat already had.
 */
const OUTRO_MS = 300;
const OUTRO_AT_MS = TAIL_AT_MS + WORD_IN_MS + HOLD_MS;
const DONE_MS = ms(OUTRO_AT_MS + OUTRO_MS);
/** Reduce motion: the copy is the point, so it still shows — it just lands whole. */
const REDUCED_DONE_MS = ms(1100);

/** Haptics land mid-word, where the eye is already being pulled. */
const WORD_HAPTIC_OFFSET_MS = Math.round(WORD_IN_MS * 0.5);

/**
 * The opening of the rhythm the reveal then accelerates: three widely spaced
 * taps, one per word, with the NAME getting the heavier one. Deliberately slow —
 * everything after this gets faster, and it can only read as faster if it starts
 * here.
 */
const CUE_HAPTIC_SCORE: EvolutionHapticBeat[] = [
  { atMs: LEAD_AT_MS + WORD_HAPTIC_OFFSET_MS, kind: 'tick' },
  { atMs: NAME_AT_MS + WORD_HAPTIC_OFFSET_MS, kind: 'build' },
  { atMs: TAIL_AT_MS + WORD_HAPTIC_OFFSET_MS, kind: 'tick' },
];

/** Breathing room between the silhouette's box and the top of the line. */
const COPY_GAP = spacing.lg;
/**
 * Worst-case height of the three-line block (23.4 + 33.6 + 23.4 + two 8pt gaps
 * ≈ 96pt) with headroom for Dynamic Type. Only used as a floor guard — see
 * `copyTop`.
 */
const COPY_HEIGHT_ALLOWANCE = 140;

type EvolutionCueProps = {
  /** Already-resolved, already-upper-cased name (see `resolveEvolvingName`). */
  name: string;
  /** Fired once the line has landed and the reveal morph should take over. */
  onDone: () => void;
  testID?: string;
};

/**
 * "What? — STEPHEN — is evolving!"
 *
 * The lead-in to the reveal morph, which is itself the evolution visual. This
 * renders as an OVERLAY on top of the lock-on's final frame rather than as a
 * screen of its own: the lock-on ends holding YOUR silhouette on a dark stage,
 * and the reveal opens on that exact same shape. Replacing the stage with a
 * separate card would break the seam the two components go out of their way to
 * hide, so the words simply appear over it.
 *
 * WHERE THE LINE SITS. Directly UNDERNEATH the silhouette, anchored to it — not
 * drawn across it, and not pinned to the bottom edge of the screen.
 *
 * All three were tried, in that order, and the difference matters:
 *
 *   - `justifyContent: 'flex-end'` put it against the screen edge, where it read
 *     as a system caption rather than as part of the beat.
 *   - Dead centre put it ON the shape. `REVEAL_ARTWORK_BOX` centres the
 *     silhouette in the middle 58% of the screen, so centred display type landed
 *     across the thing being evolved — over a fill whose colour is sampled from
 *     the user's own selfie, which made legibility a coin flip that needed a
 *     scrim to rescue. Dimming the creature during its own evolution to make
 *     room for its caption is the wrong trade, and the scrim is gone with it.
 *   - So: `resolveArtworkRect` — the SAME helper that places the silhouette — is
 *     asked where the shape's box ends, and the copy hangs one `spacing.lg`
 *     under it. It tracks the silhouette on every screen size, it sits on clean
 *     dark stage, and it needs no scrim at all.
 *
 * The copy is the app's own type scale — no trademarked wordmark or font.
 */
export function EvolutionCue({ name, onDone, testID = 'wtp-evolving' }: EvolutionCueProps) {
  const { isResolved: isMotionPreferenceKnown, reduceMotion } = useReduceMotionState();
  // A full-bleed route, so the window IS the layer — and it is known on the
  // first frame, which matters for a beat this short.
  const { height: screenHeight, width: screenWidth } = useWindowDimensions();

  const insets = useSafeAreaInsets();

  const lead = useSharedValue(0);
  const nameIn = useSharedValue(0);
  const tail = useSharedValue(0);
  /** Whole-overlay presence — drives the outro so nothing pops at the handoff. */
  const presence = useSharedValue(1);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const cancelAll = () => {
      cancelAnimation(lead);
      cancelAnimation(nameIn);
      cancelAnimation(tail);
      cancelAnimation(presence);
    };

    if (reduceMotion) {
      // No stagger, no travel, no haptic rhythm: the whole line is simply
      // present. Someone who asked for less movement still gets the gag.
      lead.value = 1;
      nameIn.value = 1;
      tail.value = 1;
      presence.value = 1;
      const doneTimer = setTimeout(() => onDoneRef.current(), REDUCED_DONE_MS);
      return () => {
        clearTimeout(doneTimer);
        cancelAll();
      };
    }

    const easing = Easing.out(Easing.cubic);
    lead.value = withDelay(ms(LEAD_AT_MS), withTiming(1, { duration: ms(WORD_IN_MS), easing }));
    nameIn.value = withDelay(ms(NAME_AT_MS), withTiming(1, { duration: ms(WORD_IN_MS), easing }));
    tail.value = withDelay(ms(TAIL_AT_MS), withTiming(1, { duration: ms(WORD_IN_MS), easing }));
    presence.value = withDelay(
      ms(OUTRO_AT_MS),
      withTiming(0, { duration: ms(OUTRO_MS), easing: Easing.in(Easing.ease) }),
    );

    const doneTimer = setTimeout(() => onDoneRef.current(), DONE_MS);
    return () => {
      clearTimeout(doneTimer);
      cancelAll();
    };
    // Plays once per mount — the parent mounts it for exactly one beat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  // The rhythm rides in its OWN effect, gated on the OS preference actually
  // having arrived. `useReduceMotionState` explains why: a cancelled animation
  // was never seen, but a cancelled haptic has already been felt.
  useEffect(() => {
    if (!isMotionPreferenceKnown || reduceMotion) {
      return;
    }
    return scheduleEvolutionHaptics(CUE_HAPTIC_SCORE, { scale: TIME_SCALE });
  }, [isMotionPreferenceKnown, reduceMotion]);

  const presenceStyle = useAnimatedStyle(() => ({ opacity: presence.value }));
  const leadStyle = useAnimatedStyle(() => ({
    opacity: lead.value,
    transform: [{ translateY: (1 - lead.value) * 10 }],
  }));
  // The name gets the only scale in the beat, so the eye lands on the person.
  const nameStyle = useAnimatedStyle(() => ({
    opacity: nameIn.value,
    transform: [{ scale: 0.86 + nameIn.value * 0.14 }],
  }));
  const tailStyle = useAnimatedStyle(() => ({
    opacity: tail.value,
    transform: [{ translateY: (1 - tail.value) * -10 }],
  }));

  /**
   * Where the copy starts: one gap below the box the silhouette is drawn in.
   *
   * SMALL SCREENS. The app is portrait-locked, and the silhouette's box is a
   * square fitted into 80% of the width, so the clear stage underneath it is
   * always ~(height − 0.8 × width) / 2 — 269pt on a 393x852, 184pt on a 375x667,
   * 176pt on a 360x640 — against a three-line block of ~96pt. There is no
   * geometry in play where this does not fit.
   *
   * The `Math.min` is a guard for the margins of that claim (Dynamic Type, a
   * device smaller than anything shipping). It reserves a deliberately generous
   * 140pt for the block, which means on the two smallest screens above it pulls
   * the copy up by 0.5pt and 8pt respectively — i.e. the gap tightens from 24pt
   * to 16pt and nothing else changes. If it ever bit harder, it would slide the
   * copy UP over the silhouette's feet rather than off the bottom of the screen:
   * overlapping the shape is recoverable, being unreadable off-screen is not.
   */
  const copyTop = useMemo(() => {
    const artworkRect = resolveArtworkRect(screenWidth, screenHeight);
    const underSilhouette = artworkRect.y + artworkRect.height + COPY_GAP;
    const floor = screenHeight - insets.bottom - spacing.md - COPY_HEIGHT_ALLOWANCE;
    return Math.max(0, Math.min(underSilhouette, floor));
  }, [insets.bottom, screenHeight, screenWidth]);

  return (
    <Animated.View pointerEvents="none" style={[styles.root, presenceStyle]} testID={testID}>
      {/* No scrim behind this. The stage under the silhouette is the lock-on's
          dark canvas at 0.9 with the selfie already faded to nothing, so white
          type on it is as high-contrast as this app gets. The scrim only ever
          existed to rescue centred copy sitting on the palette-coloured
          silhouette — that placement is gone, so the dimming goes with it. */}
      <View style={[styles.copyBlock, { top: copyTop }]} testID={`${testID}-copy`}>
        <Animated.View style={leadStyle}>
          <AppText style={styles.lead} testID={`${testID}-lead`}>
            {EVOLVING_LEAD}
          </AppText>
        </Animated.View>
        <Animated.View style={nameStyle}>
          <AppText numberOfLines={1} style={styles.name} testID={`${testID}-name`}>
            {name}
          </AppText>
        </Animated.View>
        <Animated.View style={tailStyle}>
          <AppText style={styles.tail} testID={`${testID}-tail`}>
            {EVOLVING_TAIL}
          </AppText>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: StyleSheet.absoluteFillObject,
  // Absolutely positioned rather than laid out by the root, because its `top` is
  // derived from where the SILHOUETTE ended up — it has to move with the shape,
  // not with the screen.
  copyBlock: {
    alignItems: 'center',
    gap: spacing.xxs,
    left: spacing.lg,
    position: 'absolute',
    right: spacing.lg,
  },
  lead: {
    ...textStyles.titleMedium,
    color: colors.scannerTextSecondary,
    textAlign: 'center',
  },
  name: {
    ...textStyles.displayLarge,
    color: colors.scannerTextPrimary,
    textAlign: 'center',
  },
  tail: {
    ...textStyles.titleMedium,
    color: colors.scannerTextPrimary,
    textAlign: 'center',
  },
});

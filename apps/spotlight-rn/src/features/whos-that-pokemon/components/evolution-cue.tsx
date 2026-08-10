import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { AppText, colors, spacing, textStyles } from '@spotlight/design-system';

import { useReduceMotion } from '../use-reduce-motion';
import { EVOLVING_LEAD, EVOLVING_TAIL } from '../evolution-copy';

const isTestEnv = process.env.NODE_ENV === 'test';

// Jest walks capture → scanning → lock-on → EVOLVING → reveal → result on real
// timers, so this beat is compressed rather than skipped: the same layers mount
// and `onDone` still fires, it just resolves in ~40ms.
const TIME_SCALE = isTestEnv ? 0.02 : 1;
const ms = (value: number) => Math.max(1, Math.round(value * TIME_SCALE));

// Three words, three beats — the pause between them IS the joke.
const LEAD_AT_MS = 0;
const NAME_AT_MS = 420;
const TAIL_AT_MS = 900;
const WORD_IN_MS = 260;
/** Time the finished line holds before the morph takes over. */
const HOLD_MS = 900;
const DONE_MS = ms(TAIL_AT_MS + WORD_IN_MS + HOLD_MS);
/** Reduce motion: the copy is the point, so it still shows — it just lands whole. */
const REDUCED_DONE_MS = ms(1100);

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
 * The copy is the app's own type scale — no trademarked wordmark or font.
 */
export function EvolutionCue({ name, onDone, testID = 'wtp-evolving' }: EvolutionCueProps) {
  const reduceMotion = useReduceMotion();

  const lead = useSharedValue(0);
  const nameIn = useSharedValue(0);
  const tail = useSharedValue(0);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const cancelAll = () => {
      cancelAnimation(lead);
      cancelAnimation(nameIn);
      cancelAnimation(tail);
    };

    if (reduceMotion) {
      // No stagger and no travel: the whole line is simply present. Someone who
      // asked for less movement still gets the gag, just not the animation.
      lead.value = 1;
      nameIn.value = 1;
      tail.value = 1;
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

    const doneTimer = setTimeout(() => onDoneRef.current(), DONE_MS);
    return () => {
      clearTimeout(doneTimer);
      cancelAll();
    };
    // Plays once per mount — the parent mounts it for exactly one beat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

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

  return (
    <View pointerEvents="none" style={styles.root} testID={testID}>
      {/* A soft scrim only under the copy — the silhouette behind it is the
          thing being evolved and must stay visible. */}
      <View style={styles.copyBlock}>
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  copyBlock: {
    alignItems: 'center',
    gap: spacing.xxs,
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

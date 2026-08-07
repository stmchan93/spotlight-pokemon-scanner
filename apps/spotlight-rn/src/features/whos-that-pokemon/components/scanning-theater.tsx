import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { AppText, colors, radii, spacing, textStyles } from '@spotlight/design-system';

import { useReduceMotion } from '../use-reduce-motion';
import { SelfieImage } from './selfie-image';

const isTestEnv = process.env.NODE_ENV === 'test';

// Sweep timing cribbed from the scanner reticle choreography (lock pulse runs
// 140ms out-cubic; the sweep itself reads best around 1.4s per pass).
const SWEEP_DURATION_MS = 1400;

// Deliberately slow. Nothing in this phase may change faster than ~300ms —
// quick swapping reads as a strobe, and a strobe reads as decoration rather
// than work. Everything below is either continuous motion or a step tied to a
// real event (a colour actually being sampled off the selfie).
const SWATCH_STAGGER_MS = 420;
const SWATCH_IN_MS = 420;
const STATUS_TICK_MS = 1600;
const STATUS_FADE_OUT_MS = 200;
const STATUS_FADE_IN_MS = 340;

const STATUS_LINES = [
  'Reading your aura…',
  'Consulting the Pokédex…',
  'Comparing silhouettes…',
  'Matching your colors…',
] as const;

type ScanningTheaterProps = {
  /** Local file uri of the captured selfie. */
  selfieUri: string | null;
  /** Dominant selfie colors (hex) — rendered as the swatch row. */
  palette: string[];
  testID?: string;
};

/**
 * Animated swatch: eases in on a stagger keyed by its row index, as if that
 * tone were being lifted off the selfie one at a time. These are the user's
 * REAL extracted colors (see `palette.ts`), which is the whole reason this
 * phase can look like work instead of theatre.
 */
function PaletteSwatch({ color, index, testID }: { color: string; index: number; testID?: string }) {
  const progress = useSharedValue(isTestEnv ? 1 : 0);

  useEffect(() => {
    if (isTestEnv) {
      return undefined;
    }
    progress.value = withDelay(
      index * SWATCH_STAGGER_MS,
      withTiming(1, { duration: SWATCH_IN_MS, easing: Easing.out(Easing.cubic) }),
    );
    return () => {
      cancelAnimation(progress);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.6 + progress.value * 0.4 }],
  }));

  return (
    <Animated.View
      style={[styles.swatch, { backgroundColor: color }, style]}
      testID={testID}
    />
  );
}

/**
 * The dark "scanning theater" phase: a single slow reticle sweep over the
 * dimmed selfie, the user's own colors being sampled one by one, and a status
 * line that changes at a walking pace while the real API call runs behind it.
 *
 * There is deliberately NO species roulette and NO climbing confidence number
 * here. Both used to tick several times a second, and both were inventions —
 * fast fake data is exactly what made this read as strobe lights rather than
 * analysis.
 */
export function ScanningTheater({ selfieUri, palette, testID = 'wtp-theater' }: ScanningTheaterProps) {
  const reduceMotion = useReduceMotion();

  const swatches = palette.slice(0, 5);
  const swatchCount = swatches.length;
  const [sampledCount, setSampledCount] = useState(isTestEnv ? swatchCount : 0);
  const [statusIndex, setStatusIndex] = useState(0);

  const sweepProgress = useSharedValue(0);
  const statusOpacity = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion || isTestEnv) {
      return undefined;
    }
    sweepProgress.value = withRepeat(
      withTiming(1, { duration: SWEEP_DURATION_MS, easing: Easing.inOut(Easing.cubic) }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(sweepProgress);
    };
  }, [reduceMotion, sweepProgress]);

  // The sampled counter steps in lockstep with the swatch stagger, so the
  // number describes what just appeared on screen rather than counting on its
  // own clock.
  useEffect(() => {
    if (isTestEnv) {
      setSampledCount(swatchCount);
      return undefined;
    }
    setSampledCount(0);
    const timers = Array.from({ length: swatchCount }, (_, index) =>
      setTimeout(() => setSampledCount(index + 1), index * SWATCH_STAGGER_MS + SWATCH_IN_MS),
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [swatchCount]);

  // Status line: fade out, swap the copy at the trough, fade back in. Never a
  // hard cut, never faster than STATUS_TICK_MS.
  useEffect(() => {
    if (isTestEnv) {
      return undefined;
    }
    const swapTimers: ReturnType<typeof setTimeout>[] = [];
    const timer = setInterval(() => {
      if (!reduceMotion) {
        statusOpacity.value = withSequence(
          withTiming(0, { duration: STATUS_FADE_OUT_MS, easing: Easing.in(Easing.ease) }),
          withTiming(1, { duration: STATUS_FADE_IN_MS, easing: Easing.out(Easing.ease) }),
        );
      }
      swapTimers.push(
        setTimeout(
          () => setStatusIndex((current) => (current + 1) % STATUS_LINES.length),
          reduceMotion ? 0 : STATUS_FADE_OUT_MS,
        ),
      );
    }, STATUS_TICK_MS);
    return () => {
      clearInterval(timer);
      swapTimers.forEach(clearTimeout);
      cancelAnimation(statusOpacity);
    };
  }, [reduceMotion, statusOpacity]);

  const sweepStyle = useAnimatedStyle(() => ({
    top: `${8 + sweepProgress.value * 84}%`,
  }));
  const statusStyle = useAnimatedStyle(() => ({ opacity: statusOpacity.value }));

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.reticleFrame}>
        {selfieUri ? (
          <SelfieImage
            cachePolicy="memory-disk"
            contentFit="cover"
            style={styles.selfie}
            uri={selfieUri}
          />
        ) : null}
        <View pointerEvents="none" style={styles.selfieDim} />
        {/* Corner brackets */}
        <View pointerEvents="none" style={[styles.corner, styles.cornerTopLeft]} />
        <View pointerEvents="none" style={[styles.corner, styles.cornerTopRight]} />
        <View pointerEvents="none" style={[styles.corner, styles.cornerBottomLeft]} />
        <View pointerEvents="none" style={[styles.corner, styles.cornerBottomRight]} />
        {reduceMotion ? null : (
          <Animated.View pointerEvents="none" style={[styles.sweepLine, sweepStyle]} testID={`${testID}-sweep`} />
        )}
      </View>

      <View style={styles.sampleBlock}>
        <View style={styles.swatchRow} testID={`${testID}-swatches`}>
          {swatches.map((color, index) => (
            <PaletteSwatch
              color={color}
              index={index}
              key={`${color}-${index}`}
              testID={`${testID}-swatch-${index}`}
            />
          ))}
        </View>
        <AppText style={styles.sampleCaption} testID={`${testID}-sample-count`}>
          {`${sampledCount} of ${swatchCount} tones sampled`}
        </AppText>
      </View>

      <Animated.View style={[styles.statusBlock, statusStyle]}>
        <AppText style={styles.statusText} testID={`${testID}-status`}>
          {STATUS_LINES[statusIndex]}
        </AppText>
      </Animated.View>
    </View>
  );
}

const CORNER_SIZE = 26;
const CORNER_THICKNESS = 3;

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    backgroundColor: colors.scannerCanvas,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  reticleFrame: {
    aspectRatio: 3 / 4,
    borderRadius: radii.xl,
    overflow: 'hidden',
    width: '72%',
  },
  selfie: {
    ...StyleSheet.absoluteFillObject,
  },
  selfieDim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.scannerCanvas,
    opacity: 0.35,
  },
  corner: {
    borderColor: colors.scannerTextPrimary,
    height: CORNER_SIZE,
    position: 'absolute',
    width: CORNER_SIZE,
  },
  cornerTopLeft: {
    borderLeftWidth: CORNER_THICKNESS,
    borderTopWidth: CORNER_THICKNESS,
    left: 0,
    top: 0,
  },
  cornerTopRight: {
    borderRightWidth: CORNER_THICKNESS,
    borderTopWidth: CORNER_THICKNESS,
    right: 0,
    top: 0,
  },
  cornerBottomLeft: {
    borderBottomWidth: CORNER_THICKNESS,
    borderLeftWidth: CORNER_THICKNESS,
    bottom: 0,
    left: 0,
  },
  cornerBottomRight: {
    borderBottomWidth: CORNER_THICKNESS,
    borderRightWidth: CORNER_THICKNESS,
    bottom: 0,
    right: 0,
  },
  sweepLine: {
    backgroundColor: colors.brand,
    height: 2,
    left: '6%',
    position: 'absolute',
    shadowColor: colors.brand,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
    width: '88%',
  },
  sampleBlock: {
    alignItems: 'center',
    gap: spacing.xxs,
    marginTop: spacing.xl,
  },
  swatchRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  swatch: {
    borderColor: colors.scannerOutline,
    borderRadius: radii.pill,
    borderWidth: 1,
    height: 26,
    width: 26,
  },
  sampleCaption: {
    ...textStyles.captionMedium,
    color: colors.scannerTextMuted,
  },
  statusBlock: {
    marginTop: spacing.lg,
  },
  statusText: {
    ...textStyles.captionMedium,
    color: colors.scannerTextSecondary,
    textAlign: 'center',
  },
});

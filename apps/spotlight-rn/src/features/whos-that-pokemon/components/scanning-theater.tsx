import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { AppText, colors, radii, RollingNumberText, spacing, textStyles } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';

import rouletteSpecies from '../data/roulette-species.json';
import { officialArtworkUrl } from '../artwork';
import { useReduceMotion } from '../use-reduce-motion';
import { SelfieImage } from './selfie-image';

const isTestEnv = process.env.NODE_ENV === 'test';

// Sweep timing cribbed from the scanner reticle choreography (lock pulse runs
// 140ms out-cubic; the sweep itself reads best around 1.4s per pass).
const SWEEP_DURATION_MS = 1400;
const ROULETTE_TICK_MS = 170;
const ROULETTE_TICK_REDUCED_MS = 700;
const TICKER_TICK_MS = 150;
const STATUS_TICK_MS = 1100;
const SWATCH_STAGGER_MS = 140;

const STATUS_LINES = [
  'Reading your aura…',
  'Consulting the Pokédex…',
  'Comparing silhouettes…',
  'Matching your colors…',
] as const;

type RouletteSpeciesEntry = { id: number; name: string };

type ScanningTheaterProps = {
  /** Local file uri of the captured selfie. */
  selfieUri: string | null;
  /** Dominant selfie colors (hex) — rendered as the swatch row. */
  palette: string[];
  testID?: string;
};

function shuffle<T>(entries: readonly T[]): T[] {
  const result = [...entries];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/** Animated swatch: pops in with a stagger keyed by its row index. */
function PaletteSwatch({ color, index, testID }: { color: string; index: number; testID?: string }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      index * SWATCH_STAGGER_MS,
      withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) }),
    );
    return () => {
      cancelAnimation(progress);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.4 + progress.value * 0.6 }],
  }));

  return (
    <Animated.View
      style={[styles.swatch, { backgroundColor: color }, style]}
      testID={testID}
    />
  );
}

/**
 * The dark "scanning theater" phase: reticle sweep over the dimmed selfie,
 * palette swatches animating in, a silhouette roulette cycling iconic species,
 * and a confidence ticker climbing while the real API call runs behind it.
 */
export function ScanningTheater({ selfieUri, palette, testID = 'wtp-theater' }: ScanningTheaterProps) {
  const reduceMotion = useReduceMotion();

  // Stable shuffled roulette order for this theater run.
  const roulette = useMemo(
    () => shuffle(rouletteSpecies as RouletteSpeciesEntry[]),
    [],
  );
  const [rouletteIndex, setRouletteIndex] = useState(0);
  const [statusIndex, setStatusIndex] = useState(0);
  // Confidence ticker climbs toward (but never reaches) a plausible ceiling.
  const confidenceRef = useRef(7 + Math.random() * 6);
  const [confidenceLabel, setConfidenceLabel] = useState(
    `${confidenceRef.current.toFixed(1)}%`,
  );

  const sweepProgress = useSharedValue(0);

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

  // Roulette + status + ticker intervals. Skipped under jest (the theater only
  // flashes by in tests, and interval state updates would fire outside act).
  useEffect(() => {
    if (isTestEnv) {
      return undefined;
    }
    const rouletteTimer = setInterval(() => {
      setRouletteIndex((current) => (current + 1) % roulette.length);
    }, reduceMotion ? ROULETTE_TICK_REDUCED_MS : ROULETTE_TICK_MS);
    const statusTimer = setInterval(() => {
      setStatusIndex((current) => (current + 1) % STATUS_LINES.length);
    }, STATUS_TICK_MS);
    const tickerTimer = setInterval(() => {
      // Ease toward ~97%: big strides early, crawling at the top.
      const remaining = 97 - confidenceRef.current;
      confidenceRef.current += Math.max(0.1, remaining * (0.06 + Math.random() * 0.08));
      setConfidenceLabel(`${Math.min(confidenceRef.current, 97).toFixed(1)}%`);
    }, TICKER_TICK_MS);
    return () => {
      clearInterval(rouletteTimer);
      clearInterval(statusTimer);
      clearInterval(tickerTimer);
    };
  }, [reduceMotion, roulette.length]);

  const sweepStyle = useAnimatedStyle(() => ({
    top: `${8 + sweepProgress.value * 84}%`,
  }));

  const currentSpecies = roulette[rouletteIndex] ?? roulette[0];

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

      <View style={styles.swatchRow} testID={`${testID}-swatches`}>
        {palette.slice(0, 5).map((color, index) => (
          <PaletteSwatch
            color={color}
            index={index}
            key={`${color}-${index}`}
            testID={`${testID}-swatch-${index}`}
          />
        ))}
      </View>

      <View style={styles.rouletteRow}>
        {currentSpecies ? (
          <CachedImage
            cachePolicy="memory-disk"
            contentFit="contain"
            style={styles.rouletteImage}
            // Low-alpha tint flattens the artwork into a silhouette.
            tintColor={colors.scannerTextMuted}
            uri={officialArtworkUrl(currentSpecies.id)}
          />
        ) : null}
        <AppText style={styles.rouletteName} testID={`${testID}-roulette-name`}>
          {currentSpecies?.name ?? ''}
        </AppText>
      </View>

      <View style={styles.tickerBlock}>
        <RollingNumberText
          style={styles.tickerText}
          testID={`${testID}-confidence`}
          value={confidenceLabel}
        />
        <AppText style={styles.statusText} testID={`${testID}-status`}>
          {STATUS_LINES[statusIndex]}
        </AppText>
      </View>
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
  swatchRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  swatch: {
    borderColor: colors.scannerOutline,
    borderRadius: radii.pill,
    borderWidth: 1,
    height: 22,
    width: 22,
  },
  rouletteRow: {
    alignItems: 'center',
    gap: spacing.xxs,
    marginTop: spacing.lg,
    minHeight: 96,
  },
  rouletteImage: {
    height: 72,
    opacity: 0.5,
    width: 72,
  },
  rouletteName: {
    ...textStyles.captionMedium,
    color: colors.scannerTextMuted,
  },
  tickerBlock: {
    alignItems: 'center',
    gap: spacing.xxxs,
    marginTop: spacing.md,
  },
  tickerText: {
    ...textStyles.titleLarge,
    color: colors.scannerTextPrimary,
  },
  statusText: {
    ...textStyles.captionMedium,
    color: colors.scannerTextSecondary,
  },
});

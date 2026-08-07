import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';

import { AppText, colors, spacing, textStyles } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';

import {
  assignOutlineTargets,
  describeFaceMeasurements,
  projectLandmarks,
  projectSpeciesOutline,
  rectCenter,
  resolveArtworkRect,
  resolveHeadRect,
  REVEAL_ARTWORK_HEIGHT_PCT,
  REVEAL_ARTWORK_WIDTH_PCT,
  scatterTargets,
  type NormalizedBox,
  type Point,
} from '../face-geometry';
import { useReduceMotion } from '../use-reduce-motion';
import { SelfieImage } from './selfie-image';

const isTestEnv = process.env.NODE_ENV === 'test';

// Jest walks capture → scanning → lock-on → reveal → result on real timers, so
// the whole choreography is compressed rather than skipped: the same layers
// mount, they just resolve in ~40ms.
const TIME_SCALE = isTestEnv ? 0.012 : 1;
const ms = (value: number) => Math.max(1, Math.round(value * TIME_SCALE));

// Beat 1 — landmark points bloom in, staggered.
const BLOOM_MS = 900;
// Beat 2 — the points hold on the face while the bracket and readouts land.
// Nothing is drawn BETWEEN the points: they read as measurements taken, not as
// a mesh laid over your face.
const HOLD_MS = 1000;
// Beat 3 — the SAME points fly out and settle onto the species outline.
const TRAVEL_AT_MS = BLOOM_MS + HOLD_MS;
const TRAVEL_MS = 1100;
// Beat 4 — the outline fills to a silhouette and we hand off to the reveal.
// Long enough for the LAST point to land (travel stagger) and then melt away.
const SETTLE_MS = 700;
const DONE_MS = ms(TRAVEL_AT_MS + TRAVEL_MS + SETTLE_MS);
const REDUCED_DONE_MS = ms(900);

const DOT_SIZE = 5;
/** Head bracket + caliper readouts fading back out as the points depart. */
const CHROME_OUT_MS = 320;
/** Spread between the first and last point leaving the face. */
const TRAVEL_STAGGER_MS = 420;
const TRAVEL_DURATION_MS = TRAVEL_MS * 0.82;
// Rough footprint of a two-line caliper readout, used only to keep it on screen.
const READOUT_WIDTH = 96;
const READOUT_HEIGHT = 44;

type FaceLockOnProps = {
  /** Local uri of the captured selfie the analysis plays over. */
  selfieUri: string | null;
  /**
   * Head box from the backend, normalized 0..1 against the ORIGINAL selfie.
   * Null/absent whenever segmentation failed — the overlay falls back to a
   * proportional head box rather than disappearing.
   */
  headBox?: NormalizedBox | null;
  /** Original selfie pixel dimensions — needed to undo the `cover` crop. */
  sourceWidth: number;
  sourceHeight: number;
  /** Official artwork of the matched species — the silhouette target. */
  artworkUrl: string;
  /**
   * Species outline points, normalized 0..1 against the ARTWORK image. Null
   * until the backend ships it; the points then scatter and fade instead.
   */
  speciesOutline?: Point[] | null;
  /** Top selfie palette swatch — paints the silhouette, as in `morph-loop`. */
  washColor: string;
  /** Fired once the silhouette has settled and the reveal should take over. */
  onDone: () => void;
  testID?: string;
};

type DotProps = {
  from: Point;
  to: Point;
  bloomDelay: number;
  travelDelay: number;
  travelDuration: number;
  fadeDelay: number;
  fadeDuration: number;
  color: string;
  easingIndex: number;
  testID: string;
};

// Three arrival curves so the points do not land as one slab. The first
// overshoots slightly past its target and settles back, which is what sells
// "travelled" over "slid".
const TRAVEL_EASINGS = [
  Easing.bezier(0.34, 1.4, 0.64, 1),
  Easing.out(Easing.cubic),
  Easing.inOut(Easing.quad),
] as const;

function LandmarkDot({
  from,
  to,
  bloomDelay,
  travelDelay,
  travelDuration,
  fadeDelay,
  fadeDuration,
  color,
  easingIndex,
  testID,
}: DotProps) {
  const bloom = useSharedValue(0);
  const travel = useSharedValue(0);
  const fade = useSharedValue(1);

  useEffect(() => {
    bloom.value = withDelay(
      bloomDelay,
      withTiming(1, { duration: ms(260), easing: Easing.out(Easing.back(1.6)) }),
    );
    travel.value = withDelay(
      travelDelay,
      withTiming(1, {
        duration: travelDuration,
        easing: TRAVEL_EASINGS[easingIndex % TRAVEL_EASINGS.length],
      }),
    );
    fade.value = withDelay(fadeDelay, withTiming(0, { duration: fadeDuration }));
    return () => {
      cancelAnimation(bloom);
      cancelAnimation(travel);
      cancelAnimation(fade);
    };
    // Plays once per mount; the parent re-keys the overlay to replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fromX = from.x;
  const fromY = from.y;
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;

  const style = useAnimatedStyle(() => {
    const t = travel.value;
    return {
      opacity: bloom.value * fade.value,
      transform: [
        { translateX: fromX + deltaX * t },
        { translateY: fromY + deltaY * t },
        { scale: 0.3 + bloom.value * 0.7 },
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.dot, { backgroundColor: color }, style]}
      testID={testID}
    />
  );
}

/**
 * The lock-on: the app measures your face, then the SAME landmark points it
 * measured fly outward and settle into the matched species' outline, which
 * fills to a silhouette and hands off to the classic reveal.
 *
 * Nothing here claims more precision than we have. The backend gives us a head
 * BOX, not a mesh, so the landmarks are a template projected into that box —
 * and when the box itself is missing we say "estimating" instead of pretending.
 */
export function FaceLockOn({
  selfieUri,
  headBox = null,
  sourceWidth,
  sourceHeight,
  artworkUrl,
  speciesOutline = null,
  washColor,
  onDone,
  testID = 'wtp-lockon',
}: FaceLockOnProps) {
  const reduceMotion = useReduceMotion();
  // Start from the window (correct on this full-bleed route, and available on
  // the very first frame) and switch to the measured box if the container ever
  // turns out to be smaller — every coordinate below is relative to it.
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

  const geometry = useMemo(() => {
    const head = resolveHeadRect({
      headBox,
      sourceWidth,
      sourceHeight,
      containerWidth,
      containerHeight,
    });
    const facePoints = projectLandmarks(head.rect);
    const faceCenter = rectCenter(head.rect);
    const artworkRect = resolveArtworkRect(containerWidth, containerHeight);
    const outlinePoints = projectSpeciesOutline(speciesOutline, artworkRect);
    const hasOutline = outlinePoints.length > 0;
    const targets = hasOutline
      ? assignOutlineTargets(facePoints, faceCenter, outlinePoints)
      : scatterTargets(facePoints, faceCenter);
    return {
      headRect: head.rect,
      isMeasured: head.isMeasured,
      facePoints,
      targets,
      hasOutline,
      measurements: describeFaceMeasurements(facePoints),
    };
  }, [containerHeight, containerWidth, headBox, sourceHeight, sourceWidth, speciesOutline]);

  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const selfieOpacity = useSharedValue(1);
  const scrimOpacity = useSharedValue(0.28);
  const chromeOpacity = useSharedValue(0);
  const silhouetteProgress = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) {
      // No point travel: the scene simply resolves onto the silhouette.
      selfieOpacity.value = withTiming(0, { duration: ms(320) });
      scrimOpacity.value = withTiming(0.86, { duration: ms(320) });
      silhouetteProgress.value = withDelay(ms(160), withTiming(1, { duration: ms(360) }));
      const doneTimer = setTimeout(() => onDoneRef.current(), REDUCED_DONE_MS);
      return () => {
        clearTimeout(doneTimer);
        cancelAnimation(selfieOpacity);
        cancelAnimation(scrimOpacity);
        cancelAnimation(silhouetteProgress);
      };
    }

    selfieOpacity.value = withDelay(
      ms(TRAVEL_AT_MS),
      withTiming(0, { duration: ms(620), easing: Easing.out(Easing.cubic) }),
    );
    scrimOpacity.value = withDelay(
      ms(TRAVEL_AT_MS),
      withTiming(0.9, { duration: ms(620), easing: Easing.out(Easing.cubic) }),
    );
    // Head bracket + readouts: in behind the blooming points, out when the
    // points depart.
    chromeOpacity.value = withSequence(
      withDelay(ms(180), withTiming(1, { duration: ms(420) })),
      withDelay(ms(TRAVEL_AT_MS - 600), withTiming(0, { duration: ms(CHROME_OUT_MS) })),
    );
    // The silhouette rises UNDER the arriving points — it must still be filling
    // in while they land, or the points look like they landed on a finished
    // picture instead of forming it.
    silhouetteProgress.value = withDelay(
      ms(TRAVEL_AT_MS + TRAVEL_MS * 0.62),
      withTiming(1, { duration: ms(800), easing: Easing.out(Easing.cubic) }),
    );

    const doneTimer = setTimeout(() => onDoneRef.current(), DONE_MS);
    return () => {
      clearTimeout(doneTimer);
      cancelAnimation(selfieOpacity);
      cancelAnimation(scrimOpacity);
      cancelAnimation(chromeOpacity);
      cancelAnimation(silhouetteProgress);
    };
    // Plays once per mount — the parent re-keys this component to replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  const selfieStyle = useAnimatedStyle(() => ({ opacity: selfieOpacity.value }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));
  const chromeStyle = useAnimatedStyle(() => ({ opacity: chromeOpacity.value }));
  const silhouetteStyle = useAnimatedStyle(() => ({
    opacity: silhouetteProgress.value,
    transform: [{ scale: 0.94 + silhouetteProgress.value * 0.06 }],
  }));

  const { headRect, facePoints, targets, hasOutline, isMeasured, measurements } = geometry;
  const pointCount = facePoints.length;

  return (
    <View onLayout={handleLayout} style={styles.root} testID={testID}>
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
        style={[StyleSheet.absoluteFillObject, styles.scrim, scrimStyle]}
      />

      {/* The species silhouette, painted in the selfie's own palette color —
          same treatment `morph-loop` uses, so the language is consistent. */}
      <Animated.View pointerEvents="none" style={[styles.artworkLayer, silhouetteStyle]}>
        <CachedImage
          cachePolicy="disk"
          contentFit="contain"
          style={styles.artwork}
          testID={`${testID}-silhouette`}
          tintColor={washColor}
          uri={artworkUrl}
        />
      </Animated.View>

      {reduceMotion ? null : (
        <>
          {/* Head bracket — where the analysis says your face is. */}
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFillObject, chromeStyle]}
            testID={`${testID}-head-frame`}
          >
            <Svg height={containerHeight} width={containerWidth}>
              <Path
                d={headBracketPath(headRect)}
                fill="none"
                stroke={colors.scannerTextPrimary}
                strokeOpacity={0.75}
                strokeWidth={1.5}
              />
            </Svg>
          </Animated.View>

          {facePoints.map((point, index) => {
            // Deterministic, evenly spread departure order (13 is coprime with
            // the landmark count, so consecutive indices never leave together).
            const slot = (index * 13) % pointCount;
            const departAt = TRAVEL_AT_MS + (slot / pointCount) * TRAVEL_STAGGER_MS;
            // With an outline each point holds its landing spot and then melts
            // into the silhouette; without one it fades on the way out.
            const fadeAt = hasOutline
              ? departAt + TRAVEL_DURATION_MS
              : departAt + TRAVEL_DURATION_MS * 0.2;
            return (
              <LandmarkDot
                bloomDelay={ms((index / pointCount) * BLOOM_MS * 0.8)}
                color={colors.scannerTextPrimary}
                easingIndex={index}
                fadeDelay={ms(fadeAt)}
                fadeDuration={ms(hasOutline ? 420 : 620)}
                from={point}
                key={`dot-${index}`}
                testID={`${testID}-dot-${index}`}
                to={targets[index] ?? point}
                travelDelay={ms(departAt)}
                travelDuration={ms(TRAVEL_DURATION_MS)}
              />
            );
          })}

          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFillObject, chromeStyle]}
            testID={`${testID}-readouts`}
          >
            {measurements.map((measurement, index) => (
              <View
                key={measurement.label}
                style={[
                  styles.readout,
                  {
                    // Offset off the anchor, then clamped so a face near the
                    // frame edge never pushes a readout off screen.
                    left: Math.min(
                      Math.max(spacing.xs, measurement.anchor.x + (index === 0 ? 96 : 72)),
                      Math.max(spacing.xs, containerWidth - READOUT_WIDTH),
                    ),
                    top: Math.min(
                      Math.max(spacing.xs, measurement.anchor.y - 8),
                      Math.max(spacing.xs, containerHeight - READOUT_HEIGHT),
                    ),
                  },
                ]}
              >
                <AppText style={styles.readoutLabel}>{measurement.label}</AppText>
                <AppText style={styles.readoutValue}>{measurement.value}</AppText>
              </View>
            ))}
            <AppText style={styles.caption} testID={`${testID}-caption`}>
              {isMeasured ? 'Face geometry locked' : 'Estimating your frame'}
            </AppText>
          </Animated.View>
        </>
      )}
    </View>
  );
}

/** Four corner brackets around the head box (no full rectangle — less "CCTV"). */
function headBracketPath(rect: { x: number; y: number; width: number; height: number }): string {
  const arm = Math.max(10, Math.min(rect.width, rect.height) * 0.22);
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return [
    `M ${left} ${top + arm} L ${left} ${top} L ${left + arm} ${top}`,
    `M ${right - arm} ${top} L ${right} ${top} L ${right} ${top + arm}`,
    `M ${right} ${bottom - arm} L ${right} ${bottom} L ${right - arm} ${bottom}`,
    `M ${left + arm} ${bottom} L ${left} ${bottom} L ${left} ${bottom - arm}`,
  ].join(' ');
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.scannerCanvas,
    flex: 1,
  },
  scrim: {
    backgroundColor: colors.scannerCanvas,
  },
  artworkLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artwork: {
    height: REVEAL_ARTWORK_HEIGHT_PCT,
    width: REVEAL_ARTWORK_WIDTH_PCT,
  },
  dot: {
    borderRadius: DOT_SIZE / 2,
    height: DOT_SIZE,
    left: 0,
    marginLeft: -DOT_SIZE / 2,
    marginTop: -DOT_SIZE / 2,
    position: 'absolute',
    top: 0,
    width: DOT_SIZE,
  },
  readout: {
    position: 'absolute',
  },
  readoutLabel: {
    ...textStyles.captionMedium,
    color: colors.scannerTextMuted,
  },
  readoutValue: {
    ...textStyles.captionMedium,
    color: colors.scannerTextPrimary,
  },
  caption: {
    ...textStyles.captionMedium,
    bottom: spacing.xxxl,
    color: colors.scannerTextSecondary,
    left: 0,
    position: 'absolute',
    right: 0,
    textAlign: 'center',
  },
});

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
  resolveHeadRect,
  REVEAL_ARTWORK_HEIGHT_PCT,
  REVEAL_ARTWORK_WIDTH_PCT,
  type NormalizedBox,
} from '../face-geometry';
import { useReduceMotion } from '../use-reduce-motion';
import { SelfieImage } from './selfie-image';

const isTestEnv = process.env.NODE_ENV === 'test';

// Jest walks capture → scanning → lock-on → reveal → result on real timers, so
// the whole choreography is compressed rather than skipped: the same layers
// mount, they just resolve in ~40ms.
const TIME_SCALE = isTestEnv ? 0.012 : 1;
const ms = (value: number) => Math.max(1, Math.round(value * TIME_SCALE));

// Beat 1 — the bracket finds your face.
const BLOOM_MS = 900;
// Beat 2 — it holds there.
const HOLD_MS = 1000;
// Beat 3 — the species silhouette rises and we hand off to the reveal.
const TRAVEL_AT_MS = BLOOM_MS + HOLD_MS;
const TRAVEL_MS = 1100;
const SETTLE_MS = 700;
const DONE_MS = ms(TRAVEL_AT_MS + TRAVEL_MS + SETTLE_MS);
const REDUCED_DONE_MS = ms(900);

/** Head bracket fading back out as the silhouette takes over. */
const CHROME_OUT_MS = 320;

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
  /** Top selfie palette swatch — paints the silhouette, as in `morph-loop`. */
  washColor: string;
  /** Fired once the silhouette has settled and the reveal should take over. */
  onDone: () => void;
  testID?: string;
};

/**
 * The lock-on: a bracket finds your face, holds, then the matched species'
 * silhouette rises out of it and hands off to the classic reveal.
 *
 * This used to scatter landmark dots over the face with caliper readouts
 * ("JAW 87°", "EYE SPAN 0.42w"). They were removed because they were theatre:
 * the backend gives us a head BOX, not a face mesh, so every dot was a template
 * projected into that box and every number was derived from the template rather
 * than from the person. Whatever it added in sci-fi flavour it took back in
 * claiming precision we do not have.
 */
export function FaceLockOn({
  selfieUri,
  headBox = null,
  sourceWidth,
  sourceHeight,
  artworkUrl,
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
    return { headRect: head.rect, isMeasured: head.isMeasured };
  }, [containerHeight, containerWidth, headBox, sourceHeight, sourceWidth]);

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
    // Head bracket + caption: in as the bracket finds the face, out as the
    // silhouette takes over.
    chromeOpacity.value = withSequence(
      withDelay(ms(180), withTiming(1, { duration: ms(420) })),
      withDelay(ms(TRAVEL_AT_MS - 600), withTiming(0, { duration: ms(CHROME_OUT_MS) })),
    );
    // The silhouette rises as the selfie fades, so the two cross over rather
    // than one cutting to the other.
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

  const { headRect, isMeasured } = geometry;

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
                testID={`${testID}-head-frame-path`}
              />
            </Svg>
          </Animated.View>

          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFillObject, chromeStyle]}
            testID={`${testID}-caption-layer`}
          >
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

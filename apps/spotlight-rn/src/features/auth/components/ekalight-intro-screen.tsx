import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Text, fontFamilies } from '@spotlight/design-system';

const INK = '#000000';
const PAPER = '#FFFFFF';

// Filmstrip geometry from the design handoff. One cell is narrower than the
// frame so two oversized letters overlap on screen at once; the giant font is
// cropped by the cell, so only the letterform geometry shows.
const CELL_WIDTH = 300;
const LETTER_FONT_SIZE = 1240;

// Timings (ms) — see design_handoff_ekalight_intro/README.md "Exact spec".
const SLIDE_MS = 720;
const RESOLVE_START_MS = SLIDE_MS - 60; // strip clears ~660ms in, then resolve begins
const WORD_SNAP_MS = 160;
const RULE_MS = 220;
const RULE_DELAY_MS = 80;
const TAGLINE_MS = 280;
const TAGLINE_DELAY_MS = 140;

// Total time from mount until the resolve has fully settled. Used as the
// deterministic onDone safety net (animation callbacks no-op under the
// reanimated jest mock, so we never rely solely on them).
const TOTAL_MS =
  RESOLVE_START_MS + Math.max(WORD_SNAP_MS, RULE_DELAY_MS + RULE_MS, TAGLINE_DELAY_MS + TAGLINE_MS);

const SLIDE_EASING = Easing.bezier(0.16, 0.6, 0.22, 1);
const RESOLVE_EASING = Easing.bezier(0.83, 0, 0.17, 1);

const TAGLINE_BOLD = { fontWeight: '700' } as const;

const DEFAULT_TAGLINE: ReactNode = (
  <>
    <Text style={TAGLINE_BOLD}>Scan</Text>,{' '}
    <Text style={TAGLINE_BOLD}>Price</Text>, and{' '}
    <Text style={TAGLINE_BOLD}>Track</Text> your collections.
  </>
);

type EkalightIntroScreenProps = {
  onDone: () => void;
  tagline?: ReactNode;
  word?: string;
};

export function EkalightIntroScreen({
  onDone,
  tagline = DEFAULT_TAGLINE,
  word = 'Ekalight',
}: EkalightIntroScreenProps) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const letters = word.toUpperCase().split('');
  const stripStart = CELL_WIDTH; // first letter just off the right edge
  const stripEnd = -(letters.length * CELL_WIDTH); // all letters cleared off the left

  // null = not yet checked; once resolved we know whether to play motion.
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);

  // Shared values driving the filmstrip + resolve.
  const stripX = useSharedValue(stripStart);
  const wordOpacity = useSharedValue(0);
  const wordSpacing = useSharedValue(-0.095);
  const wordScaleX = useSharedValue(1.03);
  const ruleScaleX = useSharedValue(0);
  const ruleOpacity = useSharedValue(0);
  const taglineOpacity = useSharedValue(0);
  // Tagline wipe: a cover sits over the tagline and slides off to the right
  // (no masked-view dependency available, so we animate an overlay).
  const taglineCoverX = useSharedValue(0);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  // onDone must fire exactly once even though both the animation completion
  // callback and the safety timer may resolve it.
  const doneFiredRef = useRef(false);

  // Resolve reduced-motion preference before deciding what to render.
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (!cancelled) {
          setReduceMotion(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReduceMotion(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (reduceMotion === null) {
      return;
    }

    const callDone = () => {
      if (doneFiredRef.current) {
        return;
      }
      doneFiredRef.current = true;
      onDoneRef.current?.();
    };

    if (reduceMotion) {
      // Skip the filmstrip entirely; land on sign-in essentially immediately.
      wordOpacity.value = 1;
      wordSpacing.value = -0.035;
      wordScaleX.value = 1;
      ruleScaleX.value = 1;
      ruleOpacity.value = 1;
      taglineOpacity.value = 1;
      taglineCoverX.value = -1;
      const reducedTimer = setTimeout(callDone, 16);
      return () => clearTimeout(reducedTimer);
    }

    // Filmstrip: oversized letters slide right -> left.
    stripX.value = withTiming(stripEnd, { duration: SLIDE_MS, easing: SLIDE_EASING });

    // Resolve, kicked off after the strip clears.
    wordOpacity.value = withDelay(RESOLVE_START_MS, withTiming(1, { duration: 0 }));
    wordSpacing.value = withDelay(
      RESOLVE_START_MS,
      withTiming(-0.035, { duration: WORD_SNAP_MS, easing: Easing.linear }),
    );
    wordScaleX.value = withDelay(
      RESOLVE_START_MS,
      withTiming(1, { duration: WORD_SNAP_MS, easing: Easing.linear }),
    );

    ruleOpacity.value = withDelay(RESOLVE_START_MS + RULE_DELAY_MS, withTiming(1, { duration: 0 }));
    ruleScaleX.value = withDelay(
      RESOLVE_START_MS + RULE_DELAY_MS,
      withTiming(1, { duration: RULE_MS, easing: RESOLVE_EASING }),
    );

    taglineOpacity.value = withDelay(
      RESOLVE_START_MS + TAGLINE_DELAY_MS,
      withTiming(1, { duration: 0 }),
    );
    // Cover slides fully off to the left (-1 = translated by its own width),
    // revealing the tagline left -> right. runOnJS fires onDone when the wipe
    // settles; a safety timer below guarantees onDone regardless.
    taglineCoverX.value = withDelay(
      RESOLVE_START_MS + TAGLINE_DELAY_MS,
      withSequence(
        withTiming(-1, { duration: TAGLINE_MS, easing: RESOLVE_EASING }, (finished) => {
          if (finished) {
            runOnJS(callDone)();
          }
        }),
      ),
    );

    // Deterministic safety net: under the reanimated jest mock the animation
    // completion callbacks no-op, so always schedule onDone explicitly.
    const safetyTimer = setTimeout(callDone, TOTAL_MS + 40);
    return () => clearTimeout(safetyTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  const stripStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: stripX.value }],
  }));

  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordOpacity.value,
    letterSpacing: wordSpacing.value * 62, // em -> px against the 62px wordmark
    transform: [{ scaleX: wordScaleX.value }],
  }));

  const ruleStyle = useAnimatedStyle(() => ({
    opacity: ruleOpacity.value,
    transform: [{ scaleX: ruleScaleX.value }],
  }));

  const taglineStyle = useAnimatedStyle(() => ({
    opacity: taglineOpacity.value,
  }));

  const taglineCoverStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: taglineCoverX.value * screenWidth }],
  }));

  if (reduceMotion === null) {
    // Hold on a black frame for the one tick it takes to read the a11y flag.
    return <View style={styles.root} testID="ekalight-intro-screen" />;
  }

  const showFilmstrip = !reduceMotion;

  return (
    <View style={styles.root} testID="ekalight-intro-screen">
      <View style={[styles.home, { paddingHorizontal: 26 }]} pointerEvents="none">
        <Animated.Text
          allowFontScaling={false}
          numberOfLines={1}
          style={[styles.wordmark, wordStyle]}
        >
          {word.toUpperCase()}
        </Animated.Text>

        <Animated.View style={[styles.rule, ruleStyle]} />

        <View style={styles.taglineWrap}>
          <Animated.Text
            allowFontScaling={false}
            style={[styles.tagline, taglineStyle]}
          >
            {tagline}
          </Animated.Text>
          <Animated.View style={[styles.taglineCover, taglineCoverStyle]} />
        </View>
      </View>

      {showFilmstrip ? (
        <View style={styles.burst} pointerEvents="none" testID="ekalight-intro-filmstrip">
          <Animated.View style={[styles.strip, { height: screenHeight }, stripStyle]}>
            {letters.map((char, index) => (
              <View key={`${char}-${index}`} style={styles.cell}>
                <Text allowFontScaling={false} style={styles.cellLetter}>
                  {char}
                </Text>
              </View>
            ))}
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  burst: {
    backgroundColor: INK,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 5,
  },
  cell: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
    overflow: 'hidden',
    width: CELL_WIDTH,
  },
  cellLetter: {
    color: PAPER,
    fontFamily: fontFamilies.display,
    fontSize: LETTER_FONT_SIZE,
    fontWeight: '800',
    includeFontPadding: false,
    letterSpacing: -0.04 * LETTER_FONT_SIZE,
    lineHeight: LETTER_FONT_SIZE,
    textAlign: 'center',
  },
  home: {
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 1,
  },
  root: {
    backgroundColor: INK,
    flex: 1,
  },
  rule: {
    backgroundColor: PAPER,
    height: 2,
    marginTop: 26,
    transform: [{ scaleX: 0 }],
    width: 44,
  },
  strip: {
    flexDirection: 'row',
    left: 0,
    position: 'absolute',
    top: 0,
  },
  tagline: {
    color: PAPER,
    fontFamily: fontFamilies.display,
    fontSize: 20,
    fontWeight: '300',
    letterSpacing: -0.012 * 20,
    lineHeight: 27,
    maxWidth: 300,
  },
  taglineCover: {
    backgroundColor: INK,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  taglineWrap: {
    marginTop: 26,
    maxWidth: 300,
    overflow: 'hidden',
  },
  wordmark: {
    color: PAPER,
    fontFamily: fontFamilies.display,
    fontSize: 62,
    fontWeight: '800',
    includeFontPadding: false,
    letterSpacing: -0.035 * 62,
    lineHeight: 56,
  },
});

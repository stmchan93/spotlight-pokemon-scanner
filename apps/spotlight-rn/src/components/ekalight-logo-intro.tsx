import { NavigationContext } from '@react-navigation/native';
import { useContext, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { EkalightWordmark, useSpotlightTheme } from '@spotlight/design-system';

import { EkalightMark } from '@/components/ekalight-mark';

/**
 * Home-bar logo with the launch intro (Figma 4299:94915 + the Ekalight logo
 * animation): the full wordmark holds, then the letters wipe out right-to-left
 * leaving the icon-only mark — the header's resting state (4299:95117). Plays
 * once per app launch, only when Home is actually focused; Reduce Motion and
 * every later mount render the mark alone.
 */

// Lockup geometry from EkalightWordmark (104.726x32; letters start at x38.026,
// mark art ends at x34.555), scaled to the header's 36pt logo height.
const LOGO_HEIGHT = 36;
const LOCKUP_SCALE = LOGO_HEIGHT / 32;
const MARK_WIDTH = (LOGO_HEIGHT * 56) / 52;
const WORD_START_X = 38.026 * LOCKUP_SCALE;
const MARK_END_X = 34.555 * LOCKUP_SCALE;
const WORD_WIDTH = (104.726 - 38.026) * LOCKUP_SCALE;
const WORD_GAP = WORD_START_X - MARK_END_X;

// Timing from the handed-off mp4 (75 frames @30fps): hold the full lockup,
// then collapse the letters.
const HOLD_MS = 1500;
const COLLAPSE_MS = 700;

let playedThisLaunch = false;

/** Test-only: lets Jest exercise the first-launch branch repeatedly. */
export function resetLogoIntroForTests(): void {
  playedThisLaunch = false;
}

/**
 * `useIsFocused` that treats "no navigator" (tests, isolated renders) as
 * focused instead of throwing.
 */
function useIsFocusedSafe(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
  useEffect(() => {
    if (!navigation) {
      return;
    }
    setFocused(navigation.isFocused());
    const unsubFocus = navigation.addListener('focus', () => setFocused(true));
    const unsubBlur = navigation.addListener('blur', () => setFocused(false));
    return () => {
      unsubFocus();
      unsubBlur();
    };
  }, [navigation]);
  return focused;
}

export function EkalightLogoIntro({ testID }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const isFocused = useIsFocusedSafe();
  const shouldPlayRef = useRef(!playedThisLaunch);
  const wordWidth = useSharedValue(shouldPlayRef.current ? WORD_WIDTH : 0);

  useEffect(() => {
    if (!shouldPlayRef.current || !isFocused || playedThisLaunch) {
      return;
    }
    playedThisLaunch = true;
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((reduceMotion) => {
        if (cancelled) {
          return;
        }
        if (reduceMotion) {
          wordWidth.value = 0;
          return;
        }
        wordWidth.value = withDelay(
          HOLD_MS,
          withTiming(0, { duration: COLLAPSE_MS, easing: Easing.inOut(Easing.ease) }),
        );
      })
      .catch(() => {
        if (!cancelled) {
          wordWidth.value = 0;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isFocused, wordWidth]);

  const wordStyle = useAnimatedStyle(() => ({ width: wordWidth.value }));

  return (
    <View style={styles.row} testID={testID}>
      <EkalightMark
        color={theme.colors.purple500}
        height={LOGO_HEIGHT}
        testID={testID ? `${testID}-mark` : undefined}
        width={MARK_WIDTH}
      />
      <Animated.View style={[styles.wordWindow, wordStyle]} testID={testID ? `${testID}-word` : undefined}>
        <View style={styles.wordInner}>
          <EkalightWordmark height={LOGO_HEIGHT} />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  wordWindow: {
    height: LOGO_HEIGHT,
    marginLeft: WORD_GAP,
    overflow: 'hidden',
  },
  wordInner: {
    marginLeft: -WORD_START_X,
    width: WORD_START_X + WORD_WIDTH,
  },
});

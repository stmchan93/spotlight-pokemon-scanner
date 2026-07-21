import { BlurView } from 'expo-blur';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { colors, radii } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';

import { useReduceMotion } from '../use-reduce-motion';

const isTestEnv = process.env.NODE_ENV === 'test';

// One loop: hold on you → dissolve to the Pokémon → hold → dissolve back.
const HOLD_SELFIE_MS = 900;
const MORPH_MS = 1150;
const HOLD_ARTWORK_MS = 1300;

type MorphLoopProps = {
  /** Local uri of the captured photo (the "before"). */
  selfieUri: string | null;
  /** Official artwork of the matched species (the "after"). */
  artworkUrl: string;
  /** Top palette swatch — tints the dissolve wash at the crossfade midpoint. */
  washColor: string;
  testID?: string;
};

/**
 * A contained, auto-looping "how you transformed" animation for the result
 * screen: the captured photo dissolves (blur + palette wash + a slight zoom)
 * into the matched species' official artwork, holds, then dissolves back — on
 * a loop the user can just watch, no interaction. Reduce-motion falls back to a
 * static crossfade parked on the artwork.
 */
export function MorphLoop({
  selfieUri,
  artworkUrl,
  washColor,
  testID = 'wtp-morph-loop',
}: MorphLoopProps) {
  const reduceMotion = useReduceMotion();

  // t: 0 = fully the photo, 1 = fully the Pokémon artwork.
  const t = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion || isTestEnv) {
      t.value = 1;
      return;
    }
    t.value = withRepeat(
      withSequence(
        withTiming(0, { duration: HOLD_SELFIE_MS }),
        withTiming(1, { duration: MORPH_MS, easing: Easing.inOut(Easing.cubic) }),
        withTiming(1, { duration: HOLD_ARTWORK_MS }),
        withTiming(0, { duration: MORPH_MS, easing: Easing.inOut(Easing.cubic) }),
      ),
      -1,
    );
    return () => {
      cancelAnimation(t);
    };
  }, [reduceMotion, t]);

  const selfieStyle = useAnimatedStyle(() => ({
    // Slight zoom as it dissolves so the morph reads as motion, not a cut.
    transform: [{ scale: 1 + 0.06 * t.value }],
  }));
  const artworkStyle = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ scale: interpolate(t.value, [0, 1], [0.9, 1]) }],
  }));
  // Blur + wash flare at the crossfade midpoint (t≈0.5) and fade at both ends.
  const midFlareStyle = useAnimatedStyle(() => ({
    opacity: Math.sin(Math.max(0, Math.min(1, t.value)) * Math.PI),
  }));
  const washStyle = useAnimatedStyle(() => ({
    opacity: Math.sin(Math.max(0, Math.min(1, t.value)) * Math.PI) * 0.5,
  }));

  return (
    <View style={styles.root} testID={testID}>
      {selfieUri ? (
        <Animated.View style={[StyleSheet.absoluteFillObject, selfieStyle]}>
          <CachedImage
            cachePolicy="memory-disk"
            contentFit="cover"
            style={StyleSheet.absoluteFillObject}
            uri={selfieUri}
          />
        </Animated.View>
      ) : null}

      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, midFlareStyle]}>
        <BlurView intensity={48} style={StyleSheet.absoluteFillObject} tint="dark" />
      </Animated.View>

      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, { backgroundColor: washColor }, washStyle]}
        testID={`${testID}-wash`}
      />

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
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    aspectRatio: 1,
    backgroundColor: colors.scannerCanvas,
    borderRadius: radii.xl,
    overflow: 'hidden',
    width: '100%',
  },
  artworkLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  artwork: {
    height: '78%',
    width: '86%',
  },
});

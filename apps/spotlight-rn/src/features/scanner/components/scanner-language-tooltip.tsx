import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { fontFamilies, colors } from '@spotlight/design-system';

// Speech-bubble tail from the Figma asset (2302:29022) — a 56×13 curved swoosh
// pointing down at the language pill.
const TAIL_PATH =
  'M56 0.00195434C53.9596 0.00195417 51.9198 -0.00654703 49.8794 0.011955C47.9265 0.029957 45.7408 0.0554598 43.8403 0.657031C41.7874 1.30711 40.4283 2.44374 39.0609 3.7814C38.0764 4.74352 36.1426 6.79626 35.201 7.78738C34.4303 8.59998 32.9218 10.2062 32.0981 10.9833C31.0612 11.9609 29.7796 13 27.9994 13C26.2193 13 24.9382 11.9609 23.9019 10.9843C23.0782 10.2077 21.5697 8.60048 20.7984 7.78838C19.858 6.79726 17.9242 4.74452 16.9391 3.7824C15.5693 2.44474 14.2126 1.30811 12.1603 0.658029C10.2592 0.057957 8.07292 0.0309536 6.12124 0.0129513C4.08023 -0.00555109 2.04041 0.00294975 1.07263e-06 0.00294957Z';

const BUBBLE_BACKGROUND = 'rgba(255, 255, 255, 0.9)';

type ScannerLanguageTooltipProps = {
  visible: boolean;
  /** Tap-to-dismiss; the screen also dismisses via the pill tap + a 10s timer. */
  onPress: () => void;
  testID?: string;
};

/**
 * One-time coach mark over the scanner (Figma 2302:29019): a white speech
 * bubble above the language pill — “Switch between Pokémon EN/JP!” — with a
 * curved tail pointing down at the pill. Fades in/out on `visible` (opacity
 * only → native driver); unmounts after the fade-out completes.
 */
export function ScannerLanguageTooltip({
  visible,
  onPress,
  testID = 'scanner-language-tooltip',
}: ScannerLanguageTooltipProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const [isRendered, setIsRendered] = useState(visible);

  useEffect(() => {
    if (visible) {
      setIsRendered(true);
      const animation = Animated.timing(opacity, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      });
      animation.start();
      return () => animation.stop();
    }
    const animation = Animated.timing(opacity, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) {
        setIsRendered(false);
      }
    });
    return () => animation.stop();
  }, [opacity, visible]);

  if (!isRendered) {
    return null;
  }

  return (
    <Animated.View pointerEvents={visible ? 'auto' : 'none'} style={{ opacity }}>
      <Pressable accessibilityRole="button" onPress={onPress} testID={testID}>
        <Animated.View style={styles.bubble}>
          <Text style={styles.copy}>Switch between Pokémon EN/JP!</Text>
        </Animated.View>
        <Svg height={13} style={styles.tail} viewBox="0 0 56 13" width={56}>
          <Path d={TAIL_PATH} fill={BUBBLE_BACKGROUND} />
        </Svg>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    backgroundColor: BUBBLE_BACKGROUND,
    borderRadius: 16,
    // Soft floating shadow (Figma: 0 0 50 @ 30%).
    elevation: 10,
    maxWidth: 200,
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 25,
  },
  copy: {
    color: colors.gray900,
    fontFamily: fontFamilies.bodyRegular,
    fontSize: 15,
    lineHeight: 20,
  },
  tail: {
    marginLeft: 2,
    // Tuck the tail up under the bubble's corner radius so they read as one shape.
    marginTop: -1,
  },
});

export default ScannerLanguageTooltip;

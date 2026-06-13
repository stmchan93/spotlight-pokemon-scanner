import { useEffect, useRef } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { ArrowUp } from 'iconoir-react-native';

import { useSpotlightTheme } from '../theme';

export type ScrollToTopButtonProps = {
  /**
   * When true the button fades / slides into view and becomes tappable. When
   * false it animates out and is non-interactive (pointerEvents disabled), so
   * it never blocks touches while hidden.
   */
  visible: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  /**
   * Positioning is owned by the consumer (typically `position: 'absolute'`
   * floating above the screen). The primitive only renders the chip + motion.
   */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const SIZE = 40;
const ICON_SIZE = 24;

/**
 * Floating "Back to top" button (Figma node 1252-1335): a 40x40 gray-100
 * rounded square holding a gray-800 up arrow. It is meant to appear once the
 * user has scrolled past the initial viewport and scroll back to the top on
 * press. Purely visual + animated — the caller owns scroll tracking and
 * absolute positioning via `style`.
 */
export function ScrollToTopButton({
  visible,
  onPress,
  accessibilityLabel = 'Back to top',
  style,
  testID = 'scroll-to-top-button',
}: ScrollToTopButtonProps) {
  const theme = useSpotlightTheme();
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [progress, visible]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0],
  });

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.wrap, { opacity: progress, transform: [{ translateY }] }, style]}
    >
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        hitSlop={8}
        onPress={onPress}
        style={({ pressed }) => [
          styles.button,
          {
            backgroundColor: theme.colors.gray100,
            borderRadius: theme.radii.sm,
            opacity: pressed ? 0.84 : 1,
          },
        ]}
        testID={testID}
      >
        <ArrowUp color={theme.colors.gray800} height={ICON_SIZE} width={ICON_SIZE} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    height: SIZE,
    justifyContent: 'center',
    width: SIZE,
  },
  wrap: {
    // No intrinsic positioning — the consumer supplies it via `style`.
  },
});

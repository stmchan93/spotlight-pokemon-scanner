import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { Text } from './scaled-text';
import { GlassSurface } from './glass-surface';
import { glassNavBubbleSizes, type GlassNavBubbleSize } from './glass-nav-bubble';

/** Label inset from each end of the pill (Figma 6530:17111: text at x 12). */
const PILL_PADDING_HORIZONTAL = 12;

export type GlassNavPillProps = {
  /** Shown as given: pass uppercase copy ("NEW CHAT"), never textTransform. */
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  disabled?: boolean;
  /** Height, from the bubble scale so a pill sits level with the bubbles beside it. */
  size?: GlassNavBubbleSize;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * A text action in a top bar, in the same frost glass as the `GlassNavBubble`s
 * beside it ("NEW CHAT" / "CLEAR ALL", Figma 6530:17111 + 6530:17044). Width
 * follows the label. Same material recipe as `GlassNavBubble material="frost"`:
 * light-pinned Liquid Glass with the `frostTint` floor and the `glassPill` lift;
 * solid `gray0` + lift where real glass is unavailable.
 */
export function GlassNavPill({
  label,
  onPress,
  accessibilityLabel,
  disabled = false,
  size = 'compact',
  style,
  testID,
}: GlassNavPillProps) {
  const theme = useSpotlightTheme();
  const height = glassNavBubbleSizes[size];

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.shell,
        { height },
        theme.shadows.glassPill,
        { opacity: disabled ? 0.45 : pressed ? 0.84 : 1 },
        style,
      ]}
      testID={testID}
    >
      <GlassSurface
        fallbackColor={theme.colors.gray0}
        glassColorScheme="light"
        glassEffectStyle="regular"
        glassTintColor={theme.colors.frostTint}
        interactive
        style={[styles.glass, { height }]}
      >
        <Text numberOfLines={1} style={[theme.typography.captionMedium, { color: theme.colors.gray900 }]}>
          {label}
        </Text>
      </GlassSurface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderCurve: 'continuous',
    borderRadius: 999,
  },
  glass: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 999,
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: PILL_PADDING_HORIZONTAL,
  },
});

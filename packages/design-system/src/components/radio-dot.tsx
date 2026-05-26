import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type RadioDotTone = 'light' | 'dark';

type RadioDotProps = {
  /** Whether this option is the selected one in its group. */
  selected: boolean;
  /** Outer diameter in px. Defaults to 16 to match the Figma radio instance. */
  size?: number;
  /**
   * Surface the dot sits on. `light` uses a gray-300 ring; `dark` uses a
   * lighter gray-600 ring so it reads against a dark sheet. The selected fill
   * is always brand yellow.
   */
  tone?: RadioDotTone;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function RadioDot({
  selected,
  size = 16,
  tone = 'light',
  style,
  testID,
}: RadioDotProps) {
  const theme = useSpotlightTheme();
  const ringColor = tone === 'dark' ? theme.colors.gray600 : theme.colors.gray300;

  return (
    <View
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      testID={testID}
      style={[
        styles.dot,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: selected ? 0 : 2,
          borderColor: ringColor,
          backgroundColor: selected ? theme.colors.brand : 'transparent',
        },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

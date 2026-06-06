import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type RadioDotTone = 'light' | 'dark';

type RadioDotProps = {
  /** Whether this option is the selected one in its group. */
  selected: boolean;
  /** Outer diameter in px. Defaults to 16 to match the Figma radio instance. */
  size?: number;
  /**
   * Surface the dot sits on — affects the unselected fill so it reads on either
   * surface. Selected is always a white dot with a ring and center dot in
   * `selectedColor`; unselected is a light filled circle with a gray-300 ring.
   */
  tone?: RadioDotTone;
  /**
   * Color of the selected-state ring + inner dot. Defaults to the brand lilac
   * for backwards compatibility; the scanner "Scanning for" sheet passes
   * `purple500` to match the Figma radio.
   */
  selectedColor?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function RadioDot({
  selected,
  size = 16,
  tone = 'light',
  selectedColor,
  style,
  testID,
}: RadioDotProps) {
  const theme = useSpotlightTheme();
  const activeColor = selectedColor ?? theme.colors.brand;
  const borderColor = selected ? activeColor : theme.colors.gray300;
  // Unselected stays a light filled circle: gray-50 reads on the dark scanner
  // sheet; white is the standard radio on light surfaces.
  const fillColor = selected
    ? theme.colors.gray0
    : tone === 'dark'
      ? theme.colors.gray50
      : theme.colors.gray0;
  const innerSize = Math.round(size * 0.625); // 10px dot at the 16px Figma size

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
          borderWidth: 1,
          borderColor,
          backgroundColor: fillColor,
        },
        style,
      ]}
    >
      {selected ? (
        <View
          style={{
            width: innerSize,
            height: innerSize,
            borderRadius: innerSize / 2,
            backgroundColor: activeColor,
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

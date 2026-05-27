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
   * surface. Selected is always a white dot with a brand-yellow (1px) ring and a
   * brand-yellow center dot; unselected is a light filled circle with a gray-300
   * ring.
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
  const borderColor = selected ? theme.colors.brand : theme.colors.gray300;
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
            backgroundColor: theme.colors.brand,
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

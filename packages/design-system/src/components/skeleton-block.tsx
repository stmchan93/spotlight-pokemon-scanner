import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

type SkeletonBlockProps = {
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  width?: number | `${number}%`;
};

export function SkeletonBlock({
  height = 16,
  radius,
  style,
  testID,
  width = '100%',
}: SkeletonBlockProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      accessibilityRole="progressbar"
      style={[
        styles.block,
        {
          width,
          height,
          borderRadius: radius ?? theme.radii.md,
          backgroundColor: theme.colors.field,
        },
        style,
      ]}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  block: {
    overflow: 'hidden',
  },
});

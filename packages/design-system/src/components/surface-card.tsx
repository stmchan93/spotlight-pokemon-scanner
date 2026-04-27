import { PropsWithChildren } from 'react';
import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { useSpotlightTheme } from '../theme';

type SurfaceCardProps = PropsWithChildren<{
  padding?: number;
  radius?: number;
  testID?: string;
  variant?: 'elevated' | 'muted' | 'field';
  style?: StyleProp<ViewStyle>;
}>;

export function SurfaceCard({
  children,
  padding = 16,
  radius,
  style,
  testID,
  variant = 'elevated',
}: SurfaceCardProps) {
  const theme = useSpotlightTheme();

  const backgroundColor =
    variant === 'muted'
      ? theme.colors.surfaceMuted
      : variant === 'field'
        ? theme.colors.field
        : theme.colors.canvasElevated;

  return (
    <View
      style={[
        styles.base,
        theme.shadows.card,
        {
          padding,
          borderRadius: radius ?? theme.radii.lg,
          backgroundColor,
          borderColor: theme.colors.outlineSubtle,
        },
        style,
      ]}
      testID={testID}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: 1,
  },
});

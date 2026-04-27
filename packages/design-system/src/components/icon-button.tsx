import type { ReactNode } from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type IconButtonVariant = 'elevated' | 'brand' | 'ghost';

type IconButtonProps = {
  accessibilityLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: IconButtonVariant;
};

export function IconButton({
  accessibilityLabel,
  children,
  disabled = false,
  onPress,
  size = 34,
  style,
  testID,
  variant = 'elevated',
}: IconButtonProps) {
  const theme = useSpotlightTheme();

  const colors =
    variant === 'brand'
      ? {
          backgroundColor: theme.colors.brand,
          borderColor: theme.colors.brand,
        }
      : variant === 'ghost'
        ? {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
          }
        : {
            backgroundColor: theme.colors.canvasElevated,
            borderColor: theme.colors.outlineSubtle,
          };

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          height: size,
          width: size,
          borderRadius: size / 2,
          backgroundColor: colors.backgroundColor,
          borderColor: colors.borderColor,
          opacity: disabled ? 0.45 : pressed ? 0.84 : 1,
        },
        style,
      ]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderWidth: 1,
    justifyContent: 'center',
  },
});

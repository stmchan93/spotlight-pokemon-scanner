import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'accent';
export type ButtonSize = 'sm' | 'md' | 'lg';
export type ButtonShape = 'pill' | 'rounded';
export type ButtonLabelStyleVariant = 'body' | 'bodyStrong' | 'caption' | 'control' | 'label';

type ButtonProps = {
  contentStyle?: StyleProp<ViewStyle>;
  disabled?: boolean;
  label: string;
  labelStyle?: StyleProp<TextStyle>;
  labelStyleVariant?: ButtonLabelStyleVariant;
  leadingAccessory?: ReactNode;
  onPress?: () => void;
  shape?: ButtonShape;
  size?: ButtonSize;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  trailingAccessory?: ReactNode;
  variant?: ButtonVariant;
};

const sizeMetrics: Record<ButtonSize, { minHeight: number; paddingHorizontal: number; paddingVertical: number }> = {
  sm: {
    minHeight: 36,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  md: {
    minHeight: 40,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  lg: {
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
};

export function Button({
  contentStyle,
  disabled = false,
  label,
  labelStyle,
  labelStyleVariant = 'control',
  leadingAccessory,
  onPress,
  shape = 'pill',
  size = 'md',
  style,
  testID,
  trailingAccessory,
  variant = 'primary',
}: ButtonProps) {
  const theme = useSpotlightTheme();
  const metrics = sizeMetrics[size];
  const textStyle =
    labelStyleVariant === 'caption'
      ? theme.typography.caption
      : labelStyleVariant === 'control'
        ? theme.typography.control
      : labelStyleVariant === 'body'
        ? theme.typography.body
      : labelStyleVariant === 'label'
        ? theme.typography.label
        : theme.typography.bodyStrong;

  const colors =
    variant === 'secondary'
      ? {
          backgroundColor: theme.colors.field,
          borderColor: theme.colors.outlineSubtle,
          textColor: theme.colors.textPrimary,
        }
      : variant === 'ghost'
        ? {
            backgroundColor: 'transparent',
            borderColor: 'transparent',
            textColor: theme.colors.textPrimary,
          }
      : variant === 'outline'
        ? {
            // PDP secondary action: white card on white border (#E8E8E8), dark label.
            backgroundColor: theme.colors.canvasElevated,
            borderColor: theme.colors.gray200,
            textColor: theme.colors.gray900,
          }
      : variant === 'accent'
        ? {
            // PDP ADD ITEM accent: purple/500 fill, white label.
            backgroundColor: theme.colors.purple500,
            borderColor: theme.colors.purple500,
            textColor: theme.colors.gray0,
          }
        : {
            backgroundColor: theme.colors.brandStrong,
            borderColor: theme.colors.brandStrong,
            textColor: theme.colors.gray0,
          };

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          minHeight: metrics.minHeight,
          paddingHorizontal: metrics.paddingHorizontal,
          paddingVertical: metrics.paddingVertical,
          borderRadius: shape === 'rounded' ? theme.radii.sm : 999,
          backgroundColor: colors.backgroundColor,
          borderColor: colors.borderColor,
          opacity: disabled ? 0.45 : pressed ? 0.88 : 1,
        },
        style,
      ]}
      testID={testID}
    >
      <View style={[styles.content, contentStyle]}>
        {leadingAccessory ? <View style={styles.accessory}>{leadingAccessory}</View> : null}
        <Text
          style={[
            textStyle,
            styles.label,
            {
              color: colors.textColor,
            },
            labelStyle,
          ]}
        >
          {label}
        </Text>
        {trailingAccessory ? <View style={styles.accessory}>{trailingAccessory}</View> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  accessory: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    alignItems: 'center',
    borderWidth: 1,
    justifyContent: 'center',
  },
  content: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
  },
  label: {
    flexShrink: 1,
    textAlign: 'center',
  },
});

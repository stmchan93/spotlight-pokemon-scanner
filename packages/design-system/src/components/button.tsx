import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'accent' | 'dark' | 'destructive';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';
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
  // Compact form-footer action (Figma 3083:12784 — Edit Profile CANCEL / SAVE).
  // Pair with shape="rounded" and labelStyleVariant="label" for that spec.
  xs: {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
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

  // Light/bordered variants fade when disabled via colors with the alpha BAKED
  // IN, not layer opacity: a semi-transparent layer's overlapping border+fill
  // alphas stack into a dark outline. Premixed alpha can't stack. '73' ≈ 45%.
  const withDisabledAlpha = (color: string) =>
    disabled && color.startsWith('#') && color.length === 7 ? `${color}73` : color;

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
      : variant === 'dark'
        ? {
            // Black commit CTA (e.g. Add-to-Collection CONFIRM): gray/900 fill, white label.
            backgroundColor: theme.colors.gray900,
            borderColor: theme.colors.gray900,
            textColor: theme.colors.gray0,
          }
      : variant === 'destructive'
        ? {
            // Destructive CTA (e.g. bulk Remove): danger/strong red fill, white label.
            backgroundColor: theme.colors.dangerStrong,
            borderColor: theme.colors.dangerStrong,
            textColor: theme.colors.gray0,
          }
        : {
            backgroundColor: theme.colors.brandStrong,
            borderColor: theme.colors.brandStrong,
            textColor: theme.colors.gray0,
          };

  // Disabled appearance. Filled CTAs collapse to the design-system disabled
  // token — a flat gray/400 pill, white label, NO border (Figma 3147:10840).
  // Besides matching the spec, this fixes the dark "outline" the old path drew:
  // a translucent border over a translucent fill composites to a darker edge.
  // Light / bordered variants keep their subtle premixed alpha fade instead.
  const isFilledVariant =
    variant === 'primary' || variant === 'dark' || variant === 'accent' || variant === 'destructive';
  const resolvedColors =
    !disabled
      ? colors
      : isFilledVariant
        ? {
            backgroundColor: theme.colors.gray400,
            borderColor: 'transparent',
            textColor: theme.colors.gray0,
          }
        : {
            backgroundColor: withDisabledAlpha(colors.backgroundColor),
            borderColor: withDisabledAlpha(colors.borderColor),
            textColor: withDisabledAlpha(colors.textColor),
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
          backgroundColor: resolvedColors.backgroundColor,
          borderColor: resolvedColors.borderColor,
          opacity: pressed ? 0.88 : 1,
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
              color: resolvedColors.textColor,
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

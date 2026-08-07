import { forwardRef, type ReactNode } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
  View,
} from 'react-native';

import { useSpotlightTheme } from '../theme';
import { MAX_FONT_SIZE_MULTIPLIER } from '../tokens';

/**
 * `filled` is the default rounded, tinted field used across forms and sheets.
 * `underline` is the bare single-rule field — no fill, no box, just a bottom
 * rule — used where the input IS the content of the surface rather than one row
 * of a form (the New Collection name field, Figma 3357:9430).
 */
type TextFieldVariant = 'filled' | 'underline';

type TextFieldProps = Omit<TextInputProps, 'style'> & {
  containerStyle?: StyleProp<ViewStyle>;
  helperText?: string;
  inputStyle?: StyleProp<TextStyle>;
  label?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  variant?: TextFieldVariant;
};

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField({
  containerStyle,
  helperText,
  inputStyle,
  label,
  leading,
  placeholderTextColor,
  trailing,
  variant = 'filled',
  ...inputProps
}: TextFieldProps, ref) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.fieldWrap}>
      {label ? (
        <Text maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER} style={[theme.typography.micro, styles.label]}>
          {label}
        </Text>
      ) : null}
      <View
        style={[
          styles.container,
          variant === 'underline'
            ? {
                backgroundColor: 'transparent',
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderColor: theme.colors.gray300,
                borderRadius: 0,
                borderWidth: 0,
                paddingHorizontal: 0,
              }
            : {
                backgroundColor: theme.colors.fieldLight,
                borderColor: theme.colors.outlineSubtle,
              },
          containerStyle,
        ]}
      >
        {leading}
        <TextInput
          maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
          ref={ref}
          placeholderTextColor={placeholderTextColor ?? theme.colors.textSecondary}
          style={[theme.typography.body, styles.input, inputStyle]}
          {...inputProps}
        />
        {trailing}
      </View>
      {helperText ? (
        <Text maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER} style={[theme.typography.caption, styles.helperText]}>
          {helperText}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  fieldWrap: {
    gap: 8,
  },
  helperText: {},
  input: {
    flex: 1,
  },
  label: {
    letterSpacing: 1.2,
  },
});

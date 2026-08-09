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

  /*
    `typography.body` MINUS its lineHeight.

    iOS lays a TextInput's text on exactly the line box it is given, and the
    token's 20pt box against a 15pt font leaves the descenders of "g", "y" and
    "p" clipped off at the bottom of the field. `Text` is unaffected and keeps
    the token as written — only an input needs the platform's own line box.
  */
  const { lineHeight: _lineHeight, ...inputTypography } = theme.typography.body;

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
                // Figma draws the rule at gray/400 — a touch darker than the
                // outline used on filled fields, so it reads on white.
                borderColor: theme.colors.gray400,
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
          style={[inputTypography, styles.input, inputStyle]}
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

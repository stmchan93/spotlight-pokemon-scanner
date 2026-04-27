import type { ReactNode } from 'react';
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

type TextFieldProps = Omit<TextInputProps, 'style'> & {
  containerStyle?: StyleProp<ViewStyle>;
  helperText?: string;
  inputStyle?: StyleProp<TextStyle>;
  label?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
};

export function TextField({
  containerStyle,
  helperText,
  inputStyle,
  label,
  leading,
  placeholderTextColor,
  trailing,
  ...inputProps
}: TextFieldProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.fieldWrap}>
      {label ? (
        <Text style={[theme.typography.micro, styles.label]}>{label}</Text>
      ) : null}
      <View
        style={[
          styles.container,
          {
            backgroundColor: theme.colors.fieldLight,
            borderColor: theme.colors.outlineSubtle,
          },
          containerStyle,
        ]}
      >
        {leading}
        <TextInput
          placeholderTextColor={placeholderTextColor ?? theme.colors.textSecondary}
          style={[theme.typography.body, styles.input, inputStyle]}
          {...inputProps}
        />
        {trailing}
      </View>
      {helperText ? (
        <Text style={[theme.typography.caption, styles.helperText]}>{helperText}</Text>
      ) : null}
    </View>
  );
}

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

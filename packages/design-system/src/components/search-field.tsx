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

type SearchFieldProps = Omit<TextInputProps, 'style'> & {
  containerStyle?: StyleProp<ViewStyle>;
  containerTestID?: string;
  inputStyle?: StyleProp<TextStyle>;
  leading?: ReactNode;
};

export function SearchField({
  containerStyle,
  containerTestID,
  inputStyle,
  leading,
  placeholderTextColor,
  ...inputProps
}: SearchFieldProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.field,
          borderColor: theme.colors.outlineSubtle,
        },
        containerStyle,
      ]}
      testID={containerTestID}
    >
      {leading ?? (
        <Text style={[theme.typography.titleCompact, styles.glyph, { color: theme.colors.textSecondary }]}>
          ⌕
        </Text>
      )}
      <TextInput
        placeholderTextColor={placeholderTextColor ?? theme.colors.textSecondary}
        style={[theme.typography.body, styles.input, inputStyle]}
        {...inputProps}
      />
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
  glyph: {
    lineHeight: 24,
  },
  input: {
    flex: 1,
  },
});

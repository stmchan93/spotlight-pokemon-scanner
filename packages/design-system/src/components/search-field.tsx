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

export type SearchFieldSize = 'default' | 'compact';

type SearchFieldProps = Omit<TextInputProps, 'style'> & {
  containerStyle?: StyleProp<ViewStyle>;
  containerTestID?: string;
  inputStyle?: StyleProp<TextStyle>;
  leading?: ReactNode;
  trailing?: ReactNode;
  size?: SearchFieldSize;
};

export function SearchField({
  containerStyle,
  containerTestID,
  inputStyle,
  leading,
  trailing,
  placeholderTextColor,
  size = 'default',
  ...inputProps
}: SearchFieldProps) {
  const theme = useSpotlightTheme();
  const isCompact = size === 'compact';

  const containerThemeStyle: ViewStyle = isCompact
    ? {
        backgroundColor: theme.colors.canvasElevated,
        borderColor: theme.colors.searchBorder,
      }
    : {
        backgroundColor: theme.colors.field,
        borderColor: theme.colors.outlineSubtle,
      };

  return (
    <View
      style={[
        styles.container,
        isCompact ? styles.containerCompact : styles.containerDefault,
        containerThemeStyle,
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
        style={[
          theme.typography.body,
          styles.input,
          isCompact ? styles.inputCompact : null,
          inputStyle,
        ]}
        {...inputProps}
      />
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    borderWidth: 1,
    flexDirection: 'row',
  },
  containerDefault: {
    borderRadius: 16,
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  containerCompact: {
    borderRadius: 999,
    gap: 8,
    height: 32,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  glyph: {
    lineHeight: 24,
  },
  input: {
    flex: 1,
  },
  inputCompact: {
    paddingVertical: 0,
  },
});

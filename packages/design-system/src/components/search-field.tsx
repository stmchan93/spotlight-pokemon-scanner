import type { ReactNode } from 'react';
import {
  StyleSheet,
  TextInput,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
  View,
} from 'react-native';
import { Search as SearchIcon } from 'iconoir-react-native';

import { useSpotlightTheme } from '../theme';

export type SearchFieldSize = 'default' | 'compact' | 'collection';
export type SearchFieldSurface = 'default' | 'muted';

type SearchFieldProps = Omit<TextInputProps, 'style'> & {
  containerStyle?: StyleProp<ViewStyle>;
  containerTestID?: string;
  inputStyle?: StyleProp<TextStyle>;
  leading?: ReactNode;
  trailing?: ReactNode;
  size?: SearchFieldSize;
  /**
   * Visual surface treatment. 'default' is the standard field bg. 'muted' is
   * the gray/100 bg with no border (Collection / Sales section search).
   */
  surface?: SearchFieldSurface;
};

export function SearchField({
  containerStyle,
  containerTestID,
  inputStyle,
  leading,
  trailing,
  placeholderTextColor,
  size = 'default',
  surface = 'default',
  ...inputProps
}: SearchFieldProps) {
  const theme = useSpotlightTheme();
  const isCompact = size === 'compact';
  const isCollection = size === 'collection';
  const isMuted = surface === 'muted';

  const containerThemeStyle: ViewStyle = isMuted
    ? {
        backgroundColor: theme.colors.gray100,
        borderColor: 'transparent',
      }
    : isCompact
      ? {
          backgroundColor: theme.colors.canvasElevated,
          borderColor: theme.colors.searchBorder,
        }
      : {
          backgroundColor: theme.colors.field,
          borderColor: theme.colors.outlineSubtle,
        };

  const sizeStyle = isCollection
    ? styles.containerCollection
    : isCompact
      ? styles.containerCompact
      : styles.containerDefault;

  const inputSizeStyle = isCollection
    ? styles.inputCollection
    : isCompact
      ? styles.inputCompact
      : null;

  const inputTextStyle = isCollection ? theme.typography.label : theme.typography.body;

  const iconColor = isMuted ? theme.colors.gray500 : theme.colors.gray400;
  const placeholderColor = placeholderTextColor ?? (isMuted ? theme.colors.gray500 : theme.colors.gray400);

  return (
    <View
      style={[
        styles.container,
        sizeStyle,
        containerThemeStyle,
        isMuted ? styles.containerNoBorder : null,
        containerStyle,
      ]}
      testID={containerTestID}
    >
      {leading ?? (
        <SearchIcon color={iconColor} height={16} width={16} />
      )}
      <TextInput
        placeholderTextColor={placeholderColor}
        style={[
          inputTextStyle,
          { color: theme.colors.textPrimary },
          styles.input,
          inputSizeStyle,
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
  containerNoBorder: {
    borderWidth: 0,
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
    height: 44,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  containerCollection: {
    borderRadius: 10,
    gap: 8,
    height: 40,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  input: {
    flex: 1,
  },
  inputCompact: {
    paddingVertical: 0,
  },
  inputCollection: {
    paddingVertical: 0,
  },
});

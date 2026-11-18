import { forwardRef, type ReactNode } from 'react';
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
import { MAX_FONT_SIZE_MULTIPLIER, radii, textStyles } from '../tokens';
import { usePlaceholderTypography } from './use-placeholder-typography';

export type SearchFieldSize = 'default' | 'compact' | 'collection';

/**
 * A `multiline` 'collection' field (the Ask Ekalight composer) grows with its
 * text up to this many lines, then scrolls inside. Same height as the search
 * bar while it holds one line.
 */
export const searchFieldMultilineMaxLines = 5;

/** Height of the 'collection' search bar (and a one-line multiline one). */
export const searchFieldCollectionHeight = 40;
const COLLECTION_HEIGHT = searchFieldCollectionHeight;
const COLLECTION_LINE_HEIGHT = textStyles.label.lineHeight;
const COLLECTION_MULTILINE_PADDING = (COLLECTION_HEIGHT - COLLECTION_LINE_HEIGHT) / 2;
export type SearchFieldSurface = 'default' | 'muted';

type SearchFieldProps = Omit<TextInputProps, 'style'> & {
  containerStyle?: StyleProp<ViewStyle>;
  containerTestID?: string;
  inputStyle?: StyleProp<TextStyle>;
  /** Replaces the search glyph; pass `null` for no leading glyph (chat composer). */
  leading?: ReactNode;
  trailing?: ReactNode;
  size?: SearchFieldSize;
  /**
   * Visual surface treatment. 'default' is the standard field bg. 'muted' is
   * the gray/100 bg with no border (Collection / Sales section search).
   */
  surface?: SearchFieldSurface;
  /**
   * Capitalises the placeholder only (Figma 5938:16825 "SEARCH BY VENDOR OR
   * HOBBY"); typed text keeps the user's casing. A `textTransform` on the input
   * would uppercase the value too, so the string itself is transformed.
   */
  uppercasePlaceholder?: boolean;
};

export const SearchField = forwardRef<TextInput, SearchFieldProps>(function SearchField({
  containerStyle,
  containerTestID,
  inputStyle,
  leading,
  trailing,
  placeholderTextColor,
  placeholder,
  size = 'default',
  surface = 'default',
  uppercasePlaceholder = false,
  ...inputProps
}, ref) {
  const theme = useSpotlightTheme();
  const isCompact = size === 'compact';
  const isCollection = size === 'collection';
  const isMuted = surface === 'muted';
  const isMultiline = Boolean(inputProps.multiline);

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
    ? isMultiline
      ? styles.containerCollectionMultiline
      : styles.containerCollection
    : isCompact
      ? styles.containerCompact
      : styles.containerDefault;

  const inputSizeStyle = isCollection
    ? isMultiline
      ? styles.inputCollectionMultiline
      : styles.inputCollection
    : isCompact
      ? styles.inputCompact
      : null;

  // Typography tokens carry a lineHeight, but on iOS a lineHeight near the
  // fontSize CLIPS the custom font's descenders inside TextInput (the "Lugia's
  // g is cut off" bug — same fix as the auth fields). Strip it and let the
  // font's own metrics size the line; the container height centers the text.
  const inputTypography = isCollection ? theme.typography.label : theme.typography.body;
  // Multiline keeps the token's lineHeight (the clip is a single-line problem)
  // so each wrapped line, and the grown field, has a predictable height.
  const inputTextStyle = isMultiline ? inputTypography : { ...inputTypography, lineHeight: undefined };

  const { onChangeText, placeholderStyle } = usePlaceholderTypography(inputProps);

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
      {leading === undefined ? (
        <SearchIcon color={iconColor} height={16} width={16} />
      ) : leading}
      <TextInput
        ref={ref}
        maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
        placeholder={uppercasePlaceholder ? placeholder?.toUpperCase() : placeholder}
        placeholderTextColor={placeholderColor}
        style={[
          inputTextStyle,
          { color: theme.colors.textPrimary },
          styles.input,
          inputSizeStyle,
          placeholderStyle,
          inputStyle,
        ]}
        {...inputProps}
        onChangeText={onChangeText}
      />
      {trailing}
    </View>
  );
});

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
    borderCurve: 'continuous',
    borderRadius: 16,
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  containerCompact: {
    borderCurve: 'continuous',
    borderRadius: 999,
    gap: 8,
    height: 44,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  containerCollection: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    gap: 8,
    height: COLLECTION_HEIGHT,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  // Grows from the search bar's 40pt: the input owns the vertical padding so
  // one line of Label (18) sits centred exactly as in the single-line field,
  // and trailing controls bottom-align with the last line.
  containerCollectionMultiline: {
    alignItems: 'flex-end',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    gap: 8,
    minHeight: COLLECTION_HEIGHT,
    paddingHorizontal: 12,
  },
  input: {
    flex: 1,
  },
  inputCollectionMultiline: {
    maxHeight: COLLECTION_LINE_HEIGHT * searchFieldMultilineMaxLines + COLLECTION_MULTILINE_PADDING * 2,
    paddingBottom: COLLECTION_MULTILINE_PADDING,
    paddingTop: COLLECTION_MULTILINE_PADDING,
    // Android multiline gravity defaults to centre-vertical on some OEMs.
    textAlignVertical: 'top',
  },
  inputCompact: {
    paddingVertical: 0,
  },
  inputCollection: {
    paddingVertical: 0,
  },
});

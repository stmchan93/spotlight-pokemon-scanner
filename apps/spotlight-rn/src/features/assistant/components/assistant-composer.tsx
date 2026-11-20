import { ArrowUp } from 'iconoir-react-native';
import { forwardRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { MAX_FONT_SIZE_MULTIPLIER, radii, spacing, textStyles, useSpotlightTheme } from '@spotlight/design-system';

/*
  Figma 6502:16506 (empty), 6502:16582 (text), 6502:16429 (3 lines).
  Empty: one 56pt row, 12pt padding, placeholder + a 32pt gray send button.
  With text: the text on top, a bottom row carrying a 28pt black send button
  (row inset 10pt, 2pt vertical padding), 16pt between text and row.
*/
const EMPTY_SEND_SIZE = 32;
const FILLED_SEND_SIZE = 28;
// iconoir's arrow inks 18 of its 24 units: these land the Figma 14x15 / 12x13 glyphs.
const EMPTY_GLYPH_SIZE = 18;
const FILLED_GLYPH_SIZE = 16;
const GLYPH_STROKE = 2;
const FILLED_ROW_INSET = 10;
const FILLED_ROW_PADDING_VERTICAL = 2;
const MAX_LINES = 5;
const LINE_HEIGHT = textStyles.chatBody.lineHeight;

type AssistantComposerProps = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  /** A question is in flight: the button shows a spinner and can't send again. */
  isSending: boolean;
  maxLength: number;
  onFocus?: () => void;
};

/**
 * The Ask Ekalight input. One TextInput in both layouts — only the container's
 * direction changes — so typing the first character never remounts the field
 * or drops the keyboard.
 */
export const AssistantComposer = forwardRef<TextInput, AssistantComposerProps>(function AssistantComposer(
  { value, onChangeText, onSend, isSending, maxLength, onFocus },
  ref,
) {
  const theme = useSpotlightTheme();
  const hasText = value.length > 0;
  const canSend = value.trim().length > 0 && !isSending;
  const sendSize = hasText ? FILLED_SEND_SIZE : EMPTY_SEND_SIZE;
  const glyphSize = hasText ? FILLED_GLYPH_SIZE : EMPTY_GLYPH_SIZE;
  const isDark = canSend || isSending;

  return (
    <View
      style={[
        styles.shell,
        hasText ? styles.shellFilled : styles.shellEmpty,
        // Figma's glass fill (gray-50 @ 70%) over a white page reads as flat gray-50.
        { backgroundColor: theme.colors.gray50 },
      ]}
      testID="assistant-composer"
    >
      <TextInput
        accessibilityLabel="Ask Ekalight"
        maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
        maxLength={maxLength}
        multiline
        onChangeText={onChangeText}
        onFocus={onFocus}
        placeholder="Chat with Ekalight"
        placeholderTextColor={theme.colors.gray600}
        ref={ref}
        style={[
          theme.typography.chatBody,
          styles.input,
          hasText ? styles.inputFilled : styles.inputEmpty,
          { color: theme.colors.gray900 },
        ]}
        testID="assistant-input"
        value={value}
      />
      <View style={hasText ? styles.sendRow : null}>
        <Pressable
          accessibilityLabel={isSending ? 'Waiting for the answer' : 'Send question'}
          accessibilityRole="button"
          accessibilityState={{ busy: isSending, disabled: !canSend }}
          disabled={!canSend}
          hitSlop={spacing.xxs}
          onPress={onSend}
          style={({ pressed }) => [
            styles.send,
            {
              backgroundColor: isDark ? theme.colors.gray900 : theme.colors.gray200,
              height: sendSize,
              opacity: pressed ? 0.8 : 1,
              width: sendSize,
            },
          ]}
          testID="assistant-send"
        >
          {isSending ? (
            <ActivityIndicator color={theme.colors.gray0} size="small" testID="assistant-send-spinner" />
          ) : (
            <ArrowUp
              color={isDark ? theme.colors.gray0 : theme.colors.gray900}
              height={glyphSize}
              strokeWidth={GLYPH_STROKE}
              width={glyphSize}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  shell: {
    borderCurve: 'continuous',
    borderRadius: radii.lg,
  },
  shellEmpty: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.xs,
  },
  shellFilled: {
    flexDirection: 'column',
    gap: spacing.sm,
    paddingBottom: FILLED_ROW_INSET,
    paddingHorizontal: FILLED_ROW_INSET,
    paddingTop: spacing.xs,
  },
  input: {
    maxHeight: LINE_HEIGHT * MAX_LINES,
    // Android multiline gravity defaults to centre-vertical on some OEMs; iOS
    // multiline adds its own top/bottom inset unless zeroed.
    paddingBottom: 0,
    paddingHorizontal: 0,
    paddingTop: 0,
    textAlignVertical: 'top',
  },
  inputEmpty: {
    flex: 1,
    // Android RN 0.8x can collapse an empty multiline input to zero height.
    minHeight: LINE_HEIGHT,
  },
  // Text sits 12pt in from the shell edge; the row below it is inset 10.
  inputFilled: {
    marginHorizontal: spacing.xs - FILLED_ROW_INSET,
    minHeight: LINE_HEIGHT,
  },
  sendRow: {
    alignItems: 'flex-end',
    paddingVertical: FILLED_ROW_PADDING_VERTICAL,
  },
  send: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    justifyContent: 'center',
  },
});

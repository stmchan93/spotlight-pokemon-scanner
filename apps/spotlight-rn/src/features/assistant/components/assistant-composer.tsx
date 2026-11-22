import { ArrowUp, Plus } from 'iconoir-react-native';
import { forwardRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { MAX_FONT_SIZE_MULTIPLIER, radii, spacing, textStyles, useSpotlightTheme } from '@spotlight/design-system';

import type { AssistantPhotoSource } from '@/features/assistant/assistant-photo-scan';
import { AssistantPhotoMenu } from '@/features/assistant/components/assistant-photo-attachment';

/*
  Figma 6502:16506 (empty), 6502:16582 (text), 6502:16429 (3 lines).
  Empty: one 56pt row, 12pt padding, placeholder + a 32pt gray send button.
  One line of text stays that single row (the send button turns black); only
  once the text WRAPS does it become the text-on-top layout with the send
  button on its own bottom row (user, 2026-11-21: "it should go to 1 line,
  then expand"). Row inset 10pt, 2pt vertical padding, 16pt text-to-row gap.
  The "+" (photo in chat) sits left of the field in the row, and left of the
  send button in the stacked layout; an attached photo forces the stacked one.
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
  /** Shows the "+" (Take photo / Choose photo). Omitted = no attach button. */
  onAttachPhoto?: (source: AssistantPhotoSource) => void;
  /** The attached photo's chip, drawn above the text. */
  attachment?: ReactNode;
  /** Text alone can't send yet (e.g. the photo is still being identified). */
  sendBlocked?: boolean;
  placeholder?: string;
};

/**
 * The Ask Ekalight input. One TextInput in both layouts — only the container's
 * direction changes — so typing the first character never remounts the field
 * or drops the keyboard.
 */
export const AssistantComposer = forwardRef<TextInput, AssistantComposerProps>(function AssistantComposer(
  {
    value, onChangeText, onSend, isSending, maxLength, onFocus, onAttachPhoto, attachment, sendBlocked = false,
    placeholder = 'Chat with Ekalight',
  },
  ref,
) {
  const theme = useSpotlightTheme();
  const hasText = value.length > 0;
  // Grows to the stacked layout only when the text wraps past one line.
  const [wraps, setWraps] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const hasAttachment = attachment != null && attachment !== false;
  const expanded = (hasText && wraps) || hasAttachment;
  const canSend = value.trim().length > 0 && !isSending && !sendBlocked;
  const sendSize = hasText ? FILLED_SEND_SIZE : EMPTY_SEND_SIZE;
  const glyphSize = hasText ? FILLED_GLYPH_SIZE : EMPTY_GLYPH_SIZE;
  const isDark = canSend || isSending;

  const attachButton = onAttachPhoto ? (
    <Pressable
      accessibilityLabel="Add a photo"
      accessibilityRole="button"
      accessibilityState={{ expanded: menuOpen }}
      hitSlop={spacing.xxs}
      onPress={() => setMenuOpen((open) => !open)}
      style={({ pressed }) => [
        styles.send,
        {
          backgroundColor: menuOpen ? theme.colors.gray900 : theme.colors.gray200,
          height: sendSize,
          opacity: pressed ? 0.8 : 1,
          width: sendSize,
        },
      ]}
      testID="assistant-attach"
    >
      <Plus
        color={menuOpen ? theme.colors.gray0 : theme.colors.gray900}
        height={glyphSize}
        strokeWidth={GLYPH_STROKE}
        width={glyphSize}
      />
    </Pressable>
  ) : null;

  return (
    <View>
    {menuOpen && onAttachPhoto ? (
      <AssistantPhotoMenu
        onSelect={(source) => {
          setMenuOpen(false);
          onAttachPhoto(source);
        }}
      />
    ) : null}
    <View
      style={[
        styles.shell,
        expanded ? styles.shellFilled : styles.shellEmpty,
        // Figma's glass fill (gray-50 @ 70%) over a white page reads as flat gray-50.
        { backgroundColor: theme.colors.gray50 },
      ]}
      testID="assistant-composer"
    >
      {hasAttachment ? attachment : null}
      {!expanded ? attachButton : null}
      <TextInput
        accessibilityLabel="Ask Ekalight"
        maxFontSizeMultiplier={MAX_FONT_SIZE_MULTIPLIER}
        maxLength={maxLength}
        multiline
        onChangeText={onChangeText}
        onContentSizeChange={(event) => {
          setWraps(event.nativeEvent.contentSize.height > LINE_HEIGHT * 1.5);
        }}
        onFocus={onFocus}
        // Figma 6607:11726 (owner, 2026-11-21).
        placeholder={placeholder}
        placeholderTextColor={theme.colors.gray600}
        ref={ref}
        style={[
          theme.typography.chatBody,
          styles.input,
          expanded ? styles.inputFilled : styles.inputEmpty,
          { color: theme.colors.gray900 },
        ]}
        testID="assistant-input"
        value={value}
      />
      <View style={expanded ? [styles.sendRow, attachButton ? styles.sendRowSplit : null] : null}>
        {expanded ? attachButton : null}
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
  sendRowSplit: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  send: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    justifyContent: 'center',
  },
});

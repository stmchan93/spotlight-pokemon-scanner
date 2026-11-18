import { ArrowUp } from 'iconoir-react-native';
import { forwardRef } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, type TextInput } from 'react-native';

import { SearchField, searchFieldCollectionHeight, spacing, useSpotlightTheme } from '@spotlight/design-system';

// Sits inside the 40pt search-bar shell with an even 6pt ring top/bottom.
const SEND_BUTTON_SIZE = 28;
const SEND_GLYPH_SIZE = 16;
const SEND_BUTTON_INSET = (searchFieldCollectionHeight - SEND_BUTTON_SIZE) / 2;

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
 * The Ask Ekalight input: the app's search bar (`SearchField` size
 * "collection", muted surface, uppercase placeholder) made multiline, so it
 * starts exactly as tall as every other search field and grows to ~5 lines.
 * The circular send button lives inside the field, like ChatGPT/Claude.
 */
export const AssistantComposer = forwardRef<TextInput, AssistantComposerProps>(function AssistantComposer(
  { value, onChangeText, onSend, isSending, maxLength, onFocus },
  ref,
) {
  const theme = useSpotlightTheme();
  const canSend = value.trim().length > 0 && !isSending;

  return (
    <SearchField
      accessibilityLabel="Ask Ekalight"
      containerTestID="assistant-composer"
      leading={null}
      maxLength={maxLength}
      multiline
      onChangeText={onChangeText}
      onFocus={onFocus}
      placeholder="Ask Ekalight anything"
      ref={ref}
      size="collection"
      surface="muted"
      testID="assistant-input"
      trailing={
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
              backgroundColor: canSend || isSending ? theme.colors.purple500 : theme.colors.gray300,
              borderRadius: theme.radii.pill,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
          testID="assistant-send"
        >
          {isSending ? (
            <ActivityIndicator color={theme.colors.gray0} size="small" testID="assistant-send-spinner" />
          ) : (
            <ArrowUp color={theme.colors.gray0} height={SEND_GLYPH_SIZE} strokeWidth={2.2} width={SEND_GLYPH_SIZE} />
          )}
        </Pressable>
      }
      uppercasePlaceholder
      value={value}
    />
  );
});

const styles = StyleSheet.create({
  send: {
    alignItems: 'center',
    borderCurve: 'continuous',
    height: SEND_BUTTON_SIZE,
    justifyContent: 'center',
    marginBottom: SEND_BUTTON_INSET,
    // Pulls the button toward the corner so its ring matches top/bottom.
    marginRight: SEND_BUTTON_INSET - spacing.xs,
    width: SEND_BUTTON_SIZE,
  },
});

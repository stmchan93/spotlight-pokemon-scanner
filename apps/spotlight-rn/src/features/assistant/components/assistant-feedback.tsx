import { ThumbsDown, ThumbsUp } from 'iconoir-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  ASSISTANT_FEEDBACK_NOTE_MAX_CHARS,
  type AssistantFeedback,
  type AssistantFeedbackInput,
  type AssistantFeedbackReason,
} from '@spotlight/api-client';
import { Button, IconButton, PillButton, Text, TextField, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

const BUTTON_SIZE = 30;
const GLYPH_SIZE = 16;

export const assistantFeedbackReasons: readonly { value: AssistantFeedbackReason; label: string }[] = [
  { value: 'wrong', label: 'Wrong info' },
  { value: 'not_helpful', label: 'Not helpful' },
  { value: 'too_long', label: 'Too long' },
  { value: 'wrong_cards', label: 'Wrong cards' },
  { value: 'other', label: 'Other' },
];

type AssistantFeedbackControlsProps = {
  feedback: AssistantFeedback | null;
  onChange: (input: AssistantFeedbackInput) => void;
  testID: string;
};

/** 👍/👎 under an assistant reply; 👎 opens an inline reason picker + optional note. */
export function AssistantFeedbackControls({ feedback, onChange, testID }: AssistantFeedbackControlsProps) {
  const theme = useSpotlightTheme();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(feedback?.note ?? '');
  const rating = feedback?.rating ?? null;

  const pressUp = () => {
    setPickerOpen(false);
    onChange({ rating: rating === 'up' ? null : 'up' });
  };

  const pressDown = () => {
    if (rating === 'down') {
      setPickerOpen(false);
      onChange({ rating: null });
      return;
    }
    setNoteDraft('');
    setPickerOpen(true);
    onChange({ rating: 'down' });
  };

  const pressReason = (reason: AssistantFeedbackReason) => {
    onChange({
      rating: 'down',
      reason: feedback?.reason === reason ? null : reason,
      note: feedback?.note ?? null,
    });
  };

  const finish = () => {
    const note = noteDraft.trim() || null;
    if (note !== (feedback?.note ?? null)) {
      onChange({ rating: 'down', reason: feedback?.reason ?? null, note });
    }
    setPickerOpen(false);
  };

  const iconColor = (selected: boolean) => (selected ? theme.colors.textPrimary : theme.colors.gray500);

  return (
    <View style={styles.column} testID={testID}>
      <View style={styles.row}>
        <IconButton
          accessibilityLabel="Good answer"
          onPress={pressUp}
          selected={rating === 'up'}
          size={BUTTON_SIZE}
          testID={`${testID}-up`}
          variant={rating === 'up' ? 'filled' : 'ghost'}
        >
          <ThumbsUp color={iconColor(rating === 'up')} height={GLYPH_SIZE} strokeWidth={1.8} width={GLYPH_SIZE} />
        </IconButton>
        <IconButton
          accessibilityLabel="Bad answer"
          onPress={pressDown}
          selected={rating === 'down'}
          size={BUTTON_SIZE}
          testID={`${testID}-down`}
          variant={rating === 'down' ? 'filled' : 'ghost'}
        >
          <ThumbsDown color={iconColor(rating === 'down')} height={GLYPH_SIZE} strokeWidth={1.8} width={GLYPH_SIZE} />
        </IconButton>
        {rating != null && !pickerOpen ? (
          <Text style={[theme.typography.caption, { color: theme.colors.gray500 }]} testID={`${testID}-thanks`}>
            Thanks for the feedback
          </Text>
        ) : null}
      </View>
      {pickerOpen && rating === 'down' ? (
        <View style={[styles.picker, { backgroundColor: theme.colors.gray50 }]} testID={`${testID}-picker`}>
          <Text style={theme.typography.label}>What went wrong?</Text>
          <View style={styles.reasons}>
            {assistantFeedbackReasons.map((reason) => (
              <PillButton
                key={reason.value}
                label={reason.label}
                labelRole="caption"
                onPress={() => pressReason(reason.value)}
                selected={feedback?.reason === reason.value}
                testID={`${testID}-reason-${reason.value}`}
                tone="filled"
              />
            ))}
          </View>
          <TextField
            accessibilityLabel="Tell us more (optional)"
            maxLength={ASSISTANT_FEEDBACK_NOTE_MAX_CHARS}
            onChangeText={setNoteDraft}
            onSubmitEditing={finish}
            placeholder="Tell us more (optional)"
            returnKeyType="done"
            testID={`${testID}-note`}
            value={noteDraft}
          />
          <Button
            label="Done"
            labelStyleVariant="control"
            onPress={finish}
            size="xs"
            style={styles.done}
            testID={`${testID}-done`}
            variant="dark"
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    gap: spacing.xxs,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  picker: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    gap: spacing.xxs,
    padding: spacing.xs,
  },
  reasons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xxs,
  },
  done: {
    alignSelf: 'flex-end',
  },
});

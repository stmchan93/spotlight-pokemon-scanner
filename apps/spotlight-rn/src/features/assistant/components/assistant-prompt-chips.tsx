import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { PillButton, spacing } from '@spotlight/design-system';

type AssistantPromptChipsProps = {
  prompts: readonly string[];
  onSelect: (prompt: string) => void;
  /** Each chip is `${testIDPrefix}-${index}`. */
  testIDPrefix: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Tappable prompts (starter prompts on a new chat, follow-ups under the latest
 * reply). The app's filled caption chip, but in sentence case: these are
 * questions the user is about to send, and a whole sentence in capitals reads
 * as shouting and is slower to scan than the one-word filter chips the
 * uppercase style was drawn for.
 */
export function AssistantPromptChips({ prompts, onSelect, testIDPrefix, testID, style }: AssistantPromptChipsProps) {
  if (prompts.length === 0) {
    return null;
  }
  return (
    <View style={[styles.wrap, style]} testID={testID}>
      {prompts.map((prompt, index) => (
        <PillButton
          key={prompt}
          label={prompt}
          labelRole="caption"
          onPress={() => onSelect(prompt)}
          style={styles.chip}
          testID={`${testIDPrefix}-${index}`}
          tone="filled"
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xxs,
  },
  chip: {
    maxWidth: '100%',
  },
});

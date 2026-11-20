import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

type AssistantPromptChipsProps = {
  prompts: readonly string[];
  onSelect: (prompt: string) => void;
  /** Each chip is `${testIDPrefix}-${index}`. */
  testIDPrefix: string;
  /** 'stack' = one centred chip per row (starter prompts); 'wrap' = chips flow left to right (follow-ups). */
  layout?: 'stack' | 'wrap';
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Tappable prompts: gray-50 rounded chips in sentence case (Figma 6530:17260 —
 * radius 8, 8pt padding, Regular 15 in gray-800, 8pt apart). Tapping sends the
 * chip's exact text.
 */
export function AssistantPromptChips({
  prompts,
  onSelect,
  testIDPrefix,
  layout = 'wrap',
  testID,
  style,
}: AssistantPromptChipsProps) {
  const theme = useSpotlightTheme();
  if (prompts.length === 0) {
    return null;
  }
  return (
    <View style={[layout === 'stack' ? styles.stack : styles.wrap, style]} testID={testID}>
      {prompts.map((prompt, index) => (
        <Pressable
          accessibilityRole="button"
          key={prompt}
          onPress={() => onSelect(prompt)}
          style={({ pressed }) => [
            styles.chip,
            { backgroundColor: pressed ? theme.colors.gray100 : theme.colors.gray50 },
          ]}
          testID={`${testIDPrefix}-${index}`}
        >
          <Text style={[theme.typography.chatBody, { color: theme.colors.gray800 }]}>{prompt}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    alignItems: 'center',
    gap: spacing.xxs,
  },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xxs,
  },
  chip: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    maxWidth: '100%',
    padding: spacing.xxs,
  },
});

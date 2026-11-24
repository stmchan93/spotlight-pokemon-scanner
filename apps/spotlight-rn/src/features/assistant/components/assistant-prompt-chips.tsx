import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

// Starter chips sit 10pt apart (Figma 6607:11784); no spacing token for 10.
const STACK_GAP = 10;

type AssistantPromptChipsProps = {
  prompts: readonly string[];
  onSelect: (prompt: string) => void;
  /** Each chip is `${testIDPrefix}-${index}`. */
  testIDPrefix: string;
  /** 'stack' = one full-width chip per row (starter prompts); 'wrap' = chips flow left to right (follow-ups). */
  layout?: 'stack' | 'wrap';
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Tappable prompts: gray-50 rounded chips in sentence case, radius 8, Regular 15
 * in gray-800. Follow-ups: 8pt padding, 8pt apart (Figma 6530:17260). Starters:
 * 12x8 padding, 10pt apart, full width (Figma 6607:11784). Tapping sends the chip's exact text.
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
            layout === 'stack' ? styles.chipStack : null,
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
  // Starters fill the width (owner, 2026-11-23); follow-ups stay content-sized.
  stack: {
    alignItems: 'stretch',
    gap: STACK_GAP,
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
  chipStack: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xxs,
  },
});

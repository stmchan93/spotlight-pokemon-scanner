import { NavArrowRight } from 'iconoir-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { EkalightAiFlare } from '@/components/ekalight-ai-glyph';

const GLYPH_SIZE = 20;

type AskEkalightRowProps = {
  question: string;
  onPress: () => void;
  testID: string;
};

/** A question typed into search: one tap opens the chat with it already sent. */
export function AskEkalightRow({ question, onPress, testID }: AskEkalightRowProps) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityHint="Opens Ask Ekalight with this question"
      accessibilityLabel={`Ask Ekalight: ${question}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: theme.colors.gray0, opacity: pressed ? 0.7 : 1 },
      ]}
      testID={testID}
    >
      <EkalightAiFlare size={GLYPH_SIZE} />
      <View style={styles.text}>
        <Text numberOfLines={2} style={[theme.typography.label, { color: theme.colors.gray900 }]}>
          {'Ask Ekalight: '}
          <Text style={[theme.typography.body, { color: theme.colors.gray600 }]}>{`"${question}"`}</Text>
        </Text>
      </View>
      <NavArrowRight color={theme.colors.gray500} height={GLYPH_SIZE} width={GLYPH_SIZE} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  text: {
    flex: 1,
  },
});

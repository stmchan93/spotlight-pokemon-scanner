import { Xmark } from 'iconoir-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { EkalightAiSparkle } from '@/components/ekalight-ai-glyph';

const SPARKLE_SIZE = 14;
const CLOSE_GLYPH_SIZE = 14;

/**
 * "Looking at: Charizard ex · 151" over the composer when the floating bubble
 * opened the chat from a page. The × drops the page from the rest of the chat.
 */
export function AssistantPageChip({
  label,
  onDismiss,
  testID = 'assistant-page-chip',
}: {
  label: string;
  onDismiss: () => void;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.row}>
      <View
        accessibilityLabel={`Looking at ${label}`}
        style={[styles.chip, { backgroundColor: theme.colors.purple50, borderColor: theme.colors.purple100 }]}
        testID={testID}
      >
        <EkalightAiSparkle size={SPARKLE_SIZE} />
        <Text numberOfLines={1} style={[theme.typography.caption, styles.label, { color: theme.colors.gray900 }]}>
          <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>Looking at: </Text>
          {label}
        </Text>
        <Pressable
          accessibilityLabel="Stop using this page as context"
          accessibilityRole="button"
          hitSlop={spacing.xs}
          onPress={onDismiss}
          testID={`${testID}-dismiss`}
        >
          <Xmark color={theme.colors.gray600} height={CLOSE_GLYPH_SIZE} strokeWidth={2} width={CLOSE_GLYPH_SIZE} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'flex-start',
    paddingBottom: spacing.xxs,
  },
  chip: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.xxs,
    maxWidth: '100%',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  label: {
    flexShrink: 1,
  },
});

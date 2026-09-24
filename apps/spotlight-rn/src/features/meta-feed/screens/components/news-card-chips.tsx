import { Pressable, StyleSheet, View } from 'react-native';

import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

export type NewsCardChip = {
  cardId: string;
  label: string;
};

const CHIP_HEIGHT = 22;
const DOT_SIZE = 16;

/**
 * Purple card chips under a headline (News.dc ".cardchip"): the cards a story
 * is tagged to, each opening its card page. `NewsRow` only draws plain tag
 * chips, so tappable card chips live here.
 */
export function NewsCardChips({
  chips,
  onOpenCard,
  testID,
}: {
  chips: NewsCardChip[];
  onOpenCard: (cardId: string) => void;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  if (chips.length === 0) {
    return null;
  }
  return (
    <View style={styles.row} testID={testID}>
      {chips.map((chip) => (
        <Pressable
          key={chip.cardId}
          accessibilityHint="Opens the card"
          accessibilityLabel={chip.label}
          accessibilityRole="button"
          // The chip is 22pt tall; the slop takes the target to 44.
          hitSlop={{ bottom: spacing.xs, top: spacing.xs }}
          onPress={() => onOpenCard(chip.cardId)}
          style={({ pressed }) => [
            styles.chip,
            { backgroundColor: theme.colors.purple50, opacity: pressed ? 0.8 : 1 },
          ]}
          testID={testID ? `${testID}-${chip.cardId}` : undefined}
        >
          <View style={[styles.dot, { backgroundColor: theme.colors.purple200 }]} />
          <Text numberOfLines={1} style={[theme.typography.chipLabel, { color: theme.colors.brandPurple }]}>
            {chip.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    flexDirection: 'row',
    gap: spacing.xxxs,
    height: CHIP_HEIGHT,
    paddingLeft: 3,
    paddingRight: spacing.xxs,
  },
  dot: {
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: DOT_SIZE,
    width: DOT_SIZE,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
});

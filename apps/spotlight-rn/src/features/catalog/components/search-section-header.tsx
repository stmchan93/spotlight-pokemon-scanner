import { Pressable, StyleSheet, View } from 'react-native';

import { Text, spacing, useSpotlightTheme } from '@spotlight/design-system';

type SearchSectionHeaderProps = {
  title: string;
  /** "(44K RESULTS)"; null shows the title alone. */
  countLabel?: string | null;
  onViewAll?: () => void;
  testID: string;
};

/**
 * A Search landing section heading (Figma 6597:5701): "SINGLES" in Label, its
 * "(44K RESULTS)" count in gray Caption, and VIEW ALL at the right in Overline.
 * Smaller than `SectionHeader`'s Title sizes, which is why it is its own row.
 */
export function SearchSectionHeader({ title, countLabel = null, onViewAll, testID }: SearchSectionHeaderProps) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.title}>
        <Text style={[theme.typography.label, { color: theme.colors.gray900 }]}>{title}</Text>
        {countLabel ? (
          <Text
            numberOfLines={1}
            style={[theme.typography.caption, { color: theme.colors.gray500 }]}
            testID={`${testID}-count`}
          >
            {countLabel}
          </Text>
        ) : null}
      </View>
      {onViewAll ? (
        <Pressable
          accessibilityLabel={`View all ${title.toLowerCase()}`}
          accessibilityRole="button"
          hitSlop={spacing.xxs}
          onPress={onViewAll}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          testID={`${testID}-view-all`}
        >
          <Text style={[theme.typography.overline, { color: theme.colors.gray900 }]}>VIEW ALL</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: spacing.xxs,
    justifyContent: 'space-between',
  },
  title: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: spacing.xxxs,
  },
});

import { Xmark } from 'iconoir-react-native';
import { ScrollView, StyleSheet } from 'react-native';

import type { SmartSearchChip } from '@spotlight/api-client';
import { PillButton, layout, spacing, useSpotlightTheme } from '@spotlight/design-system';

const X_SIZE = 14;

type SmartSearchChipsProps = {
  chips: SmartSearchChip[];
  onRemove: (chip: SmartSearchChip) => void;
  testID: string;
};

/** What the search understood, one removable chip per filter (the filter chip row's look). */
export function SmartSearchChips({ chips, onRemove, testID }: SmartSearchChipsProps) {
  const theme = useSpotlightTheme();
  if (chips.length === 0) {
    return null;
  }
  return (
    <ScrollView
      contentContainerStyle={styles.chips}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
      style={styles.scroller}
      testID={testID}
    >
      {chips.map((chip) => (
        <PillButton
          accessibilityLabel={`Remove ${chip.label}`}
          key={chip.id}
          label={chip.label}
          labelRole="caption"
          onPress={() => onRemove(chip)}
          selected
          testID={`${testID}-${chip.id}`}
          tone="filter"
          trailing={<Xmark color={theme.colors.gray0} height={X_SIZE} width={X_SIZE} />}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  chips: {
    gap: spacing.xxs,
    paddingHorizontal: layout.pageGutter,
  },
  // Full-bleed: the chips scroll under the page gutter.
  scroller: {
    marginHorizontal: -layout.pageGutter,
    marginTop: spacing.xs,
  },
});

import { ScrollView, StyleSheet } from 'react-native';

import { CARD_GAMES, gameDisplayName, type CardGame } from '@spotlight/api-client';
import { PillButton, spacing } from '@spotlight/design-system';

import { PageSwipeGuard } from '@/components/page-tab-pager';

/** `null` is the ALL chip, offered only when `includeAll` is set. */
export type GameFilter = CardGame | null;

type GameFilterChipsProps = {
  value: GameFilter;
  onChange: (value: GameFilter) => void;
  includeAll?: boolean;
  testID?: string;
};

/**
 * The News / Market Watch game chips (Figma 6322:7622). The swipe guard keeps a
 * drag on the row scrolling the chips instead of paging the tabs.
 */
export function GameFilterChips({ value, onChange, includeAll = false, testID = 'game-filter-chips' }: GameFilterChipsProps) {
  const options: GameFilter[] = includeAll ? [null, ...CARD_GAMES] : [...CARD_GAMES];
  return (
    <PageSwipeGuard testID={testID}>
      <ScrollView
        contentContainerStyle={styles.row}
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
      >
        {options.map((option) => (
          <PillButton
            key={option ?? 'all'}
            label={option ? gameDisplayName(option) : 'All'}
            labelRole="caption"
            onPress={() => onChange(option)}
            selected={value === option}
            testID={`${testID}-${option ?? 'all'}`}
            tone="secondary"
            uppercase
          />
        ))}
      </ScrollView>
    </PageSwipeGuard>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: spacing.xxs,
    paddingHorizontal: spacing.sm,
  },
});

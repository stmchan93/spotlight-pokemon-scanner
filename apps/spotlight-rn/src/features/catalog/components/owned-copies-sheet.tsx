import { Pressable, StyleSheet, View } from 'react-native';

import type { InventoryCardEntry } from '@spotlight/api-client';
import { Text, layout, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { ownedCopyLabel } from '@/features/catalog/set-progress';
import { InsightsBottomSheet } from '@/features/insights/components/insights-bottom-sheet';

type OwnedCopiesSheetProps = {
  visible: boolean;
  cardName: string;
  /** The user's inventory entries for this card — more than one form. */
  copies: readonly InventoryCardEntry[];
  /** A tap removes ONE from that copy and closes the sheet. */
  onSelect: (entry: InventoryCardEntry) => void;
  onClose: () => void;
};

/**
 * "Which copy?" — the set page's − when the card is owned in more than one
 * form (two printings, a raw copy and a slab…). The rule is no guessing: the
 * user picks the copy one is removed from. Built on the app's shared bottom
 * sheet shell (scrim, slide, drag-to-dismiss handle).
 */
export function OwnedCopiesSheet({ visible, cardName, copies, onSelect, onClose }: OwnedCopiesSheetProps) {
  const theme = useSpotlightTheme();

  return (
    <InsightsBottomSheet
      header={
        <View style={styles.header}>
          <Text style={[theme.typography.titleSmall, styles.centered, { color: theme.colors.gray900 }]}>
            Remove one
          </Text>
          <Text numberOfLines={1} style={[theme.typography.caption, styles.centered, { color: theme.colors.gray600 }]}>
            {cardName}
          </Text>
        </View>
      }
      onClose={onClose}
      testID="owned-copies-sheet"
      visible={visible}
    >
      <View style={styles.rows}>
        {copies.map((entry) => (
          <Pressable
            accessibilityLabel={`Remove one ${ownedCopyLabel(entry)}`}
            accessibilityRole="button"
            key={entry.id}
            onPress={() => onSelect(entry)}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
            testID={`owned-copies-sheet-row-${entry.id}`}
          >
            <Text numberOfLines={1} style={[styles.rowLabel, theme.typography.body, { color: theme.colors.gray900 }]}>
              {ownedCopyLabel(entry)}
            </Text>
            <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}>
              {`QTY: ${entry.quantity}`}
            </Text>
          </Pressable>
        ))}
      </View>
    </InsightsBottomSheet>
  );
}

const styles = StyleSheet.create({
  centered: {
    textAlign: 'center',
  },
  header: {
    gap: spacing.xxxs,
    marginTop: spacing.xs,
    paddingHorizontal: layout.pageGutter,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'space-between',
    paddingHorizontal: layout.pageGutter,
    paddingVertical: spacing.xs,
  },
  rowLabel: {
    flexShrink: 1,
  },
  rows: {
    paddingTop: spacing.xs,
  },
});

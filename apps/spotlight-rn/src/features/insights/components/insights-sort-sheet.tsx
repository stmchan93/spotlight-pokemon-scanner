import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

import { InsightsBottomSheet } from '@/features/insights/components/insights-bottom-sheet';

// Sort keys for the Insights performance table (Figma 2179:16233 "Filter By").
export type InsightsSortKey =
  | 'default'
  | 'most-valuable'
  | 'least-valuable'
  | 'winners-month'
  | 'losers-month'
  | 'all-time-growth'
  | 'most-spent';

// Figma 2179:16585/16588 say "Today", but the table's G/L columns track
// month-over-month — the winner/loser sorts follow the same window so the
// sheet copy and the sorted column agree.
export const INSIGHTS_SORT_OPTIONS: { key: InsightsSortKey; label: string }[] = [
  { key: 'default', label: 'Default Order' },
  { key: 'most-valuable', label: 'Most Valuable' },
  { key: 'least-valuable', label: 'Least Valuable' },
  { key: 'winners-month', label: 'Biggest Winners Monthly' },
  { key: 'losers-month', label: 'Biggest Losers Monthly' },
  { key: 'all-time-growth', label: 'Best All-Time Growth' },
  { key: 'most-spent', label: 'Most Spent' },
];

type InsightsSortSheetProps = {
  visible: boolean;
  /** The committed sort — the draft resets to this each time the sheet opens. */
  sortKey: InsightsSortKey;
  onApply: (next: InsightsSortKey) => void;
  onClose: () => void;
  testID?: string;
};

/**
 * "Filter By" sort sheet (Figma 2664:25051): handle, then a CANCEL / centered
 * title / APPLY header row over the sort option list (selected row = purple/50
 * fill + semibold label). Selection is a draft — only APPLY commits it; CANCEL
 * and the backdrop discard. The shell (scrim, slide, drag-to-dismiss) is
 * InsightsBottomSheet.
 */
export function InsightsSortSheet({
  visible,
  sortKey,
  onApply,
  onClose,
  testID = 'insights-sort-sheet',
}: InsightsSortSheetProps) {
  const theme = useSpotlightTheme();

  const [draftKey, setDraftKey] = useState<InsightsSortKey>(sortKey);

  useEffect(() => {
    if (visible) {
      setDraftKey(sortKey);
    }
  }, [sortKey, visible]);

  return (
    <InsightsBottomSheet
      header={
        <View style={styles.headerRow}>
          <Pressable
            accessibilityLabel="Cancel"
            accessibilityRole="button"
            hitSlop={8}
            onPress={onClose}
            style={styles.headerActionLeading}
            testID={`${testID}-cancel`}
          >
            <Text style={[theme.typography.labelStrong, { color: theme.colors.gray600 }]}>
              CANCEL
            </Text>
          </Pressable>
          <Text
            style={[theme.typography.titleSmall, styles.title, { color: theme.colors.gray900 }]}
          >
            Filter By
          </Text>
          <Pressable
            accessibilityLabel="Apply"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => onApply(draftKey)}
            style={styles.headerActionTrailing}
            testID={`${testID}-apply`}
          >
            <Text style={[theme.typography.labelStrong, { color: theme.colors.purple500 }]}>
              APPLY
            </Text>
          </Pressable>
        </View>
      }
      onClose={onClose}
      testID={testID}
      visible={visible}
    >
      <View style={styles.options}>
        {INSIGHTS_SORT_OPTIONS.map(({ key, label }) => {
          const selected = key === draftKey;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected }}
              key={key}
              onPress={() => setDraftKey(key)}
              style={[
                styles.optionRow,
                selected ? { backgroundColor: theme.colors.purple50 } : null,
              ]}
              testID={`${testID}-option-${key}`}
            >
              <Text
                style={[
                  selected ? theme.typography.captionMedium : theme.typography.caption,
                  { color: selected ? theme.colors.gray900 : theme.colors.gray700 },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </InsightsBottomSheet>
  );
}

const styles = StyleSheet.create({
  headerActionLeading: {
    alignItems: 'flex-start',
    minWidth: 56,
  },
  headerActionTrailing: {
    alignItems: 'flex-end',
    minWidth: 56,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
    paddingHorizontal: 16,
  },
  optionRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    width: '100%',
  },
  options: {
    paddingTop: 16,
  },
  title: {
    flex: 1,
    textAlign: 'center',
  },
});

export default InsightsSortSheet;

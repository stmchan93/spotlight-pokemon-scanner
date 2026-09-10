import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { PillButton, Text, colors, spacing, textStyles } from '@spotlight/design-system';

import type { SetAllConditionOption } from '@/features/scanner/scan-batch-pricing';

type OpenRail = 'printing' | 'condition' | null;

export type BinderSetAllRowProps = {
  printingOptions: readonly string[];
  conditionOptions: readonly SetAllConditionOption[];
  onSelectPrinting: (printingLabel: string) => void;
  onSelectCondition: (conditionCode: string) => void;
  /** True while a batch apply is resolving pricing matrices. */
  busy: boolean;
  testID?: string;
};

/**
 * Batch correction for a binder page: "Set all" → Printing ▾ / Condition ▾.
 * Tapping a header chip opens a rail of options beneath it; picking one
 * applies to every pocket the page can price that way (the caller reports
 * "Applied to 7 of 9 · 2 have no Holofoil printing"). Nobody in the category
 * offers this — every competitor makes the user fix nine cards one by one.
 */
export function BinderSetAllRow({
  busy,
  conditionOptions,
  onSelectCondition,
  onSelectPrinting,
  printingOptions,
  testID = 'binder-set-all',
}: BinderSetAllRowProps) {
  const [open, setOpen] = useState<OpenRail>(null);
  const toggle = (rail: Exclude<OpenRail, null>) => setOpen((current) => (current === rail ? null : rail));

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>Set all</Text>
        <PillButton
          label="Printing ▾"
          onPress={() => toggle('printing')}
          selected={open === 'printing'}
          testID={`${testID}-printing`}
          tone="option"
        />
        <PillButton
          label="Condition ▾"
          onPress={() => toggle('condition')}
          selected={open === 'condition'}
          testID={`${testID}-condition`}
          tone="option"
        />
        {busy ? <ActivityIndicator color={colors.scannerTextPrimary} size="small" /> : null}
      </View>
      {open ? (
        <ScrollView
          contentContainerStyle={styles.rail}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          testID={`${testID}-${open}-rail`}
        >
          {open === 'printing'
            ? printingOptions.map((printing) => (
              <PillButton
                key={printing}
                label={printing}
                onPress={() => {
                  setOpen(null);
                  onSelectPrinting(printing);
                }}
                testID={`${testID}-printing-${printing.toLowerCase().replace(/\s+/g, '-')}`}
                tone="option"
              />
            ))
            : conditionOptions.map((condition) => (
              <PillButton
                key={condition.code}
                label={condition.label}
                onPress={() => {
                  setOpen(null);
                  onSelectCondition(condition.code);
                }}
                testID={`${testID}-condition-${condition.code}`}
                tone="option"
              />
            ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: spacing.xxs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxxs,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  label: {
    ...textStyles.overline,
    color: colors.scannerTextPrimary,
  },
  rail: {
    flexDirection: 'row',
    gap: spacing.xxs,
  },
});

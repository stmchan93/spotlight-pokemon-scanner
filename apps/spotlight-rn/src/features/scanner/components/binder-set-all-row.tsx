import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { PillButton, Text, colors, spacing, textStyles } from '@spotlight/design-system';

type OpenRail = 'printing' | null;

export type BinderSetAllRowProps = {
  printingOptions: readonly string[];
  onSelectPrinting: (printingLabel: string) => void;
  /** True while a batch apply is resolving pricing matrices. */
  busy: boolean;
  testID?: string;
};

/**
 * Batch correction for a binder page: "Set all" → Printing ▾ (printing only —
 * condition is per card in the price sheet, by user decision 2026-09-09).
 * Tapping a header chip opens a rail of options beneath it; picking one
 * applies to every pocket the page can price that way (the caller reports
 * "Applied to 7 of 9 · 2 have no Holofoil printing"). Nobody in the category
 * offers this — every competitor makes the user fix nine cards one by one.
 */
export function BinderSetAllRow({
  busy,
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
          {printingOptions.map((printing) => (
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

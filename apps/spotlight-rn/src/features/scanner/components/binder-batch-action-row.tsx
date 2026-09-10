import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { IconChevronDown } from '@tabler/icons-react-native';

import { Text, colors, textStyles } from '@spotlight/design-system';

import {
  AnchoredOptionMenu,
  type AnchoredMenuAnchor,
  type AnchoredOption,
} from '@/features/scanner/components/printing-menu';
import type { SetAllConditionOption } from '@/features/scanner/scan-batch-pricing';

type OpenMenu = 'variant' | 'condition' | null;

export type BinderBatchActionRowProps = {
  /** Variant labels ("Normal", "Holofoil", …) the dropdown offers. */
  printingOptions: readonly string[];
  conditionOptions: readonly SetAllConditionOption[];
  onSelectPrinting: (printingLabel: string) => void;
  onSelectCondition: (conditionCode: string) => void;
  /** How many pockets the user is holding-to-select. The row only exists while this is > 0. */
  selectedCount: number;
  /** Leave selection mode. */
  onDone: () => void;
  /** True while a batch apply is resolving pricing matrices. */
  busy: boolean;
  testID?: string;
};

const slug = (label: string) => label.toLowerCase().replace(/\s+/g, '-');

/** Matches the camera's scan-mode dropdown (`binderModePill`). */
const PILL_HEIGHT = 30;

/**
 * The binder page's selection toolbar: a VARIANT dropdown, a CONDITION
 * dropdown, and Done — nothing else.
 *
 * ONLY WHILE SELECTING. This row used to sit on the page permanently as
 * "Set all · Printing ▾ · Condition ▾", addressing the whole page when nothing
 * was held. That put two dropdowns over a page whose one job is being glanced
 * at against a real binder (user, 2026-09-09), so the page at rest carries only
 * the "Hold to edit" hint and the hold gesture brings this row in with it.
 *
 * NO COUNT AND NO "ALL". A "3 selected" readout restates what the ticks on the
 * tiles already say, and a Select-all button is a second way to do what holding
 * and tapping does — both were spending width that Done needed to be legible
 * (user, 2026-09-09: "they should know how many they selected from just tapping
 * them"). Done is a filled pill for the same reason: it is the way out, so it
 * has to be findable.
 *
 * The triggers are the scanner's ordinary dropdown pill — white chip, 12pt
 * label, a REAL chevron glyph (a "▾" text triangle reads as a down arrow; see
 * the tray's ADD pill) — opening the same `AnchoredOptionMenu` the tray row's
 * printing picker uses, so every dropdown in the scanner is one component.
 * Picking an option applies it to every selected pocket that can be priced that
 * way and the caller reports the rest ("Applied to 7 of 9 · 2 have no Holofoil
 * variant").
 */
export function BinderBatchActionRow({
  busy,
  conditionOptions,
  onDone,
  onSelectCondition,
  onSelectPrinting,
  printingOptions,
  selectedCount,
  testID = 'binder-batch-actions',
}: BinderBatchActionRowProps) {
  const [open, setOpen] = useState<OpenMenu>(null);
  const [anchor, setAnchor] = useState<AnchoredMenuAnchor | null>(null);
  const variantRef = useRef<View | null>(null);
  const conditionRef = useRef<View | null>(null);

  // Open at once, then hang the menu off the pill once its window coords
  // arrive. Opening only INSIDE the measure callback would leave a pill that
  // never measures (a detached node, the test renderer) with a dead dropdown.
  const openMenu = (menu: Exclude<OpenMenu, null>) => {
    if (open === menu) {
      setOpen(null);
      return;
    }
    setOpen(menu);
    const node = menu === 'variant' ? variantRef.current : conditionRef.current;
    if (node && typeof node.measureInWindow === 'function') {
      node.measureInWindow((x, y, width, height) => {
        setAnchor({ x, y, width, height });
      });
    }
  };

  const variantOptions: AnchoredOption[] = printingOptions.map((label) => ({ key: slug(label), label }));
  const conditionMenuOptions: AnchoredOption[] = conditionOptions.map((condition) => ({
    key: condition.code.toLowerCase(),
    label: condition.label,
  }));

  const trigger = (
    kind: Exclude<OpenMenu, null>,
    label: string,
    ref: React.RefObject<View | null>,
  ) => (
    <View collapsable={false} key={kind} ref={ref}>
      <Pressable
        accessibilityLabel={`${label} for the selected cards`}
        accessibilityRole="button"
        accessibilityState={{ expanded: open === kind }}
        onPress={() => openMenu(kind)}
        style={({ pressed }) => [
          styles.pill,
          open === kind || pressed ? styles.pillActive : null,
        ]}
        testID={`${testID}-${kind}`}
      >
        <Text style={styles.pillLabel}>{label}</Text>
        <IconChevronDown color={colors.gray900} size={14} strokeWidth={2.2} />
      </Pressable>
    </View>
  );

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.headerRow}>
        {trigger('variant', 'Variant', variantRef)}
        {trigger('condition', 'Condition', conditionRef)}
        <Pressable
          accessibilityLabel="Stop selecting"
          accessibilityRole="button"
          onPress={onDone}
          style={({ pressed }) => [styles.done, pressed ? styles.donePressed : null]}
          testID={`${testID}-done`}
        >
          <Text style={styles.doneLabel}>Done</Text>
        </Pressable>
        {busy ? <ActivityIndicator color={colors.scannerTextPrimary} size="small" /> : null}
      </View>
      <AnchoredOptionMenu
        accessibilityLabelFor={(option) => `Set the variant to ${option.label}`}
        anchor={anchor}
        onClose={() => setOpen(null)}
        onSelect={(option) => {
          setOpen(null);
          const label = printingOptions.find((candidate) => slug(candidate) === option.key);
          if (label) {
            onSelectPrinting(label);
          }
        }}
        options={variantOptions}
        selectedKey={null}
        testID={`${testID}-variant-menu`}
        visible={open === 'variant'}
      />
      <AnchoredOptionMenu
        accessibilityLabelFor={(option) => `Set the condition to ${option.label}`}
        anchor={anchor}
        onClose={() => setOpen(null)}
        onSelect={(option) => {
          setOpen(null);
          const condition = conditionOptions.find((candidate) => candidate.code.toLowerCase() === option.key);
          if (condition) {
            onSelectCondition(condition.code);
          }
        }}
        options={conditionMenuOptions}
        selectedKey={null}
        testID={`${testID}-condition-menu`}
        visible={open === 'condition'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  done: {
    alignItems: 'center',
    backgroundColor: colors.scannerAddPurple,
    borderCurve: 'continuous',
    borderRadius: 999,
    height: PILL_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  doneLabel: {
    ...textStyles.labelStrong,
    color: colors.gray0,
    fontSize: 13,
  },
  donePressed: {
    opacity: 0.85,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    // 8 between the two dropdowns and Done.
    gap: 8,
  },
  pill: {
    alignItems: 'center',
    backgroundColor: colors.gray0,
    borderCurve: 'continuous',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    height: PILL_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  pillActive: {
    opacity: 0.85,
  },
  pillLabel: {
    // Matches the scan-mode pill on the camera — one dropdown shape in the
    // scanner, whichever screen it is on.
    ...textStyles.labelStrong,
    color: colors.gray900,
    fontSize: 12,
  },
  root: {
    // 16 clear of the header above and the first row of pockets below, and the
    // controls start on the page's own 16 gutter.
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
});

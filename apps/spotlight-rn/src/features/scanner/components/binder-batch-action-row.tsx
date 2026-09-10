import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { IconChevronDown } from '@tabler/icons-react-native';

import { Text, colors, textStyles } from '@spotlight/design-system';

import {
  AnchoredOptionMenu,
  type AnchoredMenuAnchor,
  type AnchoredOption,
} from '@/features/scanner/components/printing-menu';

export type BinderBatchActionRowProps = {
  /** Variant labels ("Normal", "Holofoil", …) the dropdown offers. */
  printingOptions: readonly string[];
  onSelectPrinting: (printingLabel: string) => void;
  /** How many pockets the user is holding-to-select. The row only exists while this is > 0. */
  selectedCount: number;
  /** Leave selection mode. */
  onDone: () => void;
  /** True while a batch apply is resolving pricing matrices. */
  busy: boolean;
  /**
   * Left inset in px. The grid below centers its columns inside the page
   * gutter, so on most phones the first card starts well right of that gutter;
   * the caller passes the measured column offset to line this row up with the
   * card edge rather than the screen edge.
   */
  insetLeft?: number;
  testID?: string;
};

const slug = (label: string) => label.toLowerCase().replace(/\s+/g, '-');

/** Matches the camera's scan-mode dropdown (`binderModePill`). */
const PILL_HEIGHT = 30;

/**
 * The binder page's selection toolbar: a VARIANT dropdown and Done — nothing
 * else.
 *
 * VARIANT ONLY. A second CONDITION dropdown sat beside it until 2026-09-10.
 * Every scan already starts on NM, so it mostly restated the default, and the
 * per-pocket confirmation two batch fields needed was what made the grid move
 * (user: "it kinda makes the ui kinda like moves"). Condition stays on the
 * card's own price sheet, where one card is being priced at a time.
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
  insetLeft,
  onDone,
  onSelectPrinting,
  printingOptions,
  selectedCount,
  testID = 'binder-batch-actions',
}: BinderBatchActionRowProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchoredMenuAnchor | null>(null);
  const variantRef = useRef<View | null>(null);

  // Open at once, then hang the menu off the pill once its window coords
  // arrive. Opening only INSIDE the measure callback would leave a pill that
  // never measures (a detached node, the test renderer) with a dead dropdown.
  const openMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    const node = variantRef.current;
    if (node && typeof node.measureInWindow === 'function') {
      node.measureInWindow((x, y, width, height) => {
        setAnchor({ x, y, width, height });
      });
    }
  };

  const variantOptions: AnchoredOption[] = printingOptions.map((label) => ({ key: slug(label), label }));

  return (
    <View
      style={[styles.root, insetLeft != null ? { paddingLeft: insetLeft } : null]}
      testID={testID}
    >
      <View style={styles.headerRow}>
        <View collapsable={false} ref={variantRef}>
          <Pressable
            accessibilityLabel="Variant for the selected cards"
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={openMenu}
            style={({ pressed }) => [styles.pill, open || pressed ? styles.pillActive : null]}
            testID={`${testID}-variant`}
          >
            <Text style={styles.pillLabel}>Variant</Text>
            <IconChevronDown color={colors.gray900} size={14} strokeWidth={2.2} />
          </Pressable>
        </View>
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
        onClose={() => setOpen(false)}
        onSelect={(option) => {
          setOpen(false);
          const label = printingOptions.find((candidate) => slug(candidate) === option.key);
          if (label) {
            onSelectPrinting(label);
          }
        }}
        options={variantOptions}
        selectedKey={null}
        testID={`${testID}-variant-menu`}
        visible={open}
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
    // 16 clear of the header above and the first row of pockets below. The left
    // gutter is the page's 16 only until `insetLeft` supplies the real column
    // offset of the grid underneath.
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
});

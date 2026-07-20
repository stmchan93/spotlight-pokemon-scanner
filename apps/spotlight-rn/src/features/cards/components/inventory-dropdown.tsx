import { Fragment, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ArrowDown, ArrowUp, BoxIso, NavArrowDown, NavArrowUp, Trash } from 'iconoir-react-native';

import { AppText, borderWidths, radii, useSpotlightTheme } from '@spotlight/design-system';
import { deckConditionOptions, type InventoryCardEntry } from '@spotlight/api-client';

import { getCardImageUrl } from '@/lib/card-images';
import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

type InventoryDropdownProps = {
  /** The user's owned entries of the card this PDP shows. */
  entries: readonly InventoryCardEntry[];
  /**
   * "EN" / "JP" chip for every row's summary line — the displayed card's
   * language (all entries here belong to the same card, so it's card-level).
   */
  language?: string | null;
  /** Row tap — e.g. re-open the PDP pinned to that entry's edit context. */
  onPressEntry?: (entry: InventoryCardEntry) => void;
  /** Trash tap — delete that entry (the current entry opens confirm-delete). */
  onPressEntryMenu: (entry: InventoryCardEntry) => void;
  initiallyExpanded?: boolean;
  testID?: string;
};

/**
 * Grade/condition code for the summary line: "PSA 10" for a slab, the short
 * condition code ("NM") for raw.
 */
function entryGradeCode(entry: InventoryCardEntry): string | null {
  if (entry.kind === 'graded' && entry.slabContext) {
    const { grader, grade } = entry.slabContext;
    return [grader, grade].filter(Boolean).join(' ') || null;
  }
  return (
    entry.conditionShortLabel
    ?? deckConditionOptions.find((option) => option.code === entry.conditionCode)?.shortLabel
    ?? null
  );
}

/** Print variant: a slab's variant lives on its slabContext, raw on the entry. */
function entryVariantName(entry: InventoryCardEntry): string | null {
  const variant =
    entry.kind === 'graded'
      ? entry.slabContext?.variantName ?? entry.variantName
      : entry.variantName;
  return variant?.trim() || null;
}

/**
 * Inventory dropdown (Figma 2481:2067 "Variant3"): an expandable outlined
 * container between the PDP identity block and the product options, listing the
 * user's owned entries of this card. Collapsed by default; the header row
 * toggles it. Each expanded row shows the card thumb, a "code · variant · lang"
 * summary with quantity, a MoreHoriz per-entry actions trigger, and the entry's
 * market price — no day-change delta and no cost-basis strikethrough (both
 * explicitly removed in this design).
 */
export function InventoryDropdown({
  entries,
  language,
  onPressEntry,
  onPressEntryMenu,
  initiallyExpanded = false,
  testID,
}: InventoryDropdownProps) {
  const theme = useSpotlightTheme();
  const [expanded, setExpanded] = useState(initiallyExpanded);

  const Chevron = expanded ? NavArrowUp : NavArrowDown;

  return (
    <View
      style={[
        styles.shell,
        { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray300 },
      ]}
      testID={testID}
    >
      <Pressable
        accessibilityLabel={expanded ? 'Collapse inventory' : 'Expand inventory'}
        accessibilityRole="button"
        onPress={() => setExpanded((current) => !current)}
        style={styles.headerRow}
        testID={testID ? `${testID}-header` : undefined}
      >
        <View style={styles.headerTitle}>
          <BoxIso color={theme.colors.gray900} height={16} width={16} />
          <AppText color="gray900" variant="bodyMedium">
            Inventory
          </AppText>
        </View>
        <Chevron color={theme.colors.gray900} height={20} width={20} />
      </Pressable>

      {expanded ? (
        <View style={styles.entries}>
          {entries.map((entry, index) => {
            const summary = [entryGradeCode(entry), entryVariantName(entry), language]
              .filter(Boolean)
              .join(' · ');
            const rowTestID = testID ? `${testID}-row-${entry.id}` : undefined;
            // When the user entered a cost basis, show the per-unit change from it
            // as a green/red delta pill next to the market price (Figma 2472-7659).
            const costChange =
              entry.hasMarketPrice && entry.costBasisPerUnit != null
                ? entry.marketPrice - entry.costBasisPerUnit
                : null;
            return (
              <Fragment key={entry.id}>
                {index > 0 ? (
                  <View
                    style={[styles.divider, { backgroundColor: theme.colors.gray200 }]}
                  />
                ) : null}
                <Pressable
                  accessibilityRole={onPressEntry ? 'button' : undefined}
                  disabled={!onPressEntry}
                  onPress={onPressEntry ? () => onPressEntry(entry) : undefined}
                  style={styles.entryRow}
                  testID={rowTestID}
                >
                  <CachedImage
                    cachePolicy={imageCachePolicy.thumbnail}
                    style={styles.entryImage}
                    uri={getCardImageUrl(entry, 'thumbnail')}
                  />
                  <View style={styles.entryBody}>
                    <View style={styles.entrySummaryLine}>
                      <View style={styles.entrySummaryGroup}>
                        <AppText
                          color="gray900"
                          numberOfLines={1}
                          style={styles.entrySummaryText}
                          variant="label"
                        >
                          {summary}
                        </AppText>
                        <View style={styles.entryQuantity}>
                          <BoxIso color={theme.colors.gray900} height={14} width={14} />
                          <AppText color="gray900" variant="label">
                            {entry.quantity}
                          </AppText>
                        </View>
                      </View>
                      <Pressable
                        accessibilityLabel="Delete entry"
                        accessibilityRole="button"
                        hitSlop={8}
                        onPress={() => onPressEntryMenu(entry)}
                        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                        testID={rowTestID ? `${rowTestID}-menu` : undefined}
                      >
                        <Trash color={theme.colors.gray900} height={22} width={22} />
                      </Pressable>
                    </View>
                    <View style={styles.priceRow}>
                      <AppText color="gray900" variant="bodyMedium">
                        {entry.hasMarketPrice
                          ? formatCurrency(entry.marketPrice, entry.currencyCode)
                          : '—'}
                      </AppText>
                      {costChange != null ? (
                        <>
                          <AppText color="gray600" variant="label">
                            {formatCurrency(entry.costBasisPerUnit ?? 0, entry.currencyCode)}
                          </AppText>
                          <View
                            style={[
                              styles.deltaPill,
                              {
                                backgroundColor:
                                  costChange < 0
                                    ? theme.colors.deltaDownSurface
                                    : theme.colors.deltaUpSurface,
                              },
                            ]}
                          >
                            {costChange < 0 ? (
                              <ArrowDown color={theme.colors.deltaDownText} height={13} width={13} />
                            ) : (
                              <ArrowUp color={theme.colors.deltaUpText} height={13} width={13} />
                            )}
                            <AppText
                              style={{
                                color:
                                  costChange < 0
                                    ? theme.colors.deltaDownText
                                    : theme.colors.deltaUpText,
                              }}
                              variant="label"
                            >
                              {formatCurrency(Math.abs(costChange), entry.currencyCode)}
                            </AppText>
                          </View>
                        </>
                      ) : null}
                    </View>
                  </View>
                </Pressable>
              </Fragment>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  divider: {
    height: borderWidths.containerRule,
    width: '100%',
  },
  entries: {
    gap: 10,
  },
  entryBody: {
    flex: 1,
    gap: 12,
  },
  // Small card thumb: stretches to the row height, 16/22 card aspect (Figma
  // 2481:2067 — renders ~40px wide against the two-line entry body).
  entryImage: {
    alignSelf: 'stretch',
    aspectRatio: 16 / 22,
    borderRadius: 2,
  },
  entryQuantity: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  priceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  // Figma 2472-7659 delta pill: green/100 (or red) fill, 4px radius, arrow + amount.
  deltaPill: {
    alignItems: 'center',
    borderRadius: 4,
    flexDirection: 'row',
    gap: 3.5,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  entryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  entrySummaryGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 8,
  },
  entrySummaryLine: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  entrySummaryText: {
    flexShrink: 1,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerTitle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  shell: {
    borderRadius: radii.md,
    borderWidth: borderWidths.containerRule,
    gap: 12,
    padding: 14,
  },
});

export default InventoryDropdown;

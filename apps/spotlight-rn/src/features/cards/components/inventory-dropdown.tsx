import { Fragment } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ArrowDown, ArrowUp, BoxIso, MoreHoriz, NavArrowDown, NavArrowUp } from 'iconoir-react-native';

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
  /**
   * "..." tap — open the per-entry actions popover (Add another / Delete),
   * anchored to the tapped trigger's measured screen rect (null if unmeasurable).
   */
  onPressEntryMenu: (
    entry: InventoryCardEntry,
    anchor: { x: number; y: number; width: number; height: number } | null,
  ) => void;
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

type InventoryQtyPillProps = {
  entries: readonly InventoryCardEntry[];
  expanded: boolean;
  onPress: () => void;
  testID?: string;
};

/**
 * "Qty: N ▾" pill beside the PDP card name (Figma 6322:8769) — the trigger for
 * the owned-copies list. N is the total quantity across every owned entry.
 */
export function InventoryQtyPill({ entries, expanded, onPress, testID }: InventoryQtyPillProps) {
  const theme = useSpotlightTheme();
  const total = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  const Chevron = expanded ? NavArrowUp : NavArrowDown;
  return (
    <Pressable
      accessibilityLabel={expanded ? 'Collapse inventory' : 'Expand inventory'}
      accessibilityRole="button"
      // The pill is ~24pt tall; the slop takes it past the 44pt touch minimum.
      hitSlop={{ bottom: 10, top: 10 }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.7 : 1 },
      ]}
      testID={testID}
    >
      <BoxIso color={theme.colors.gray900} height={16} width={16} />
      <AppText color="gray900" variant="overline">
        {`Qty: ${total}`}
      </AppText>
      <Chevron color={theme.colors.gray900} height={20} width={20} />
    </Pressable>
  );
}

/**
 * Owned-copies list (Figma 2481:2067 rows), opened from {@link InventoryQtyPill}.
 * Each row shows the card thumb, a "code · variant · lang" summary with
 * quantity, a MoreHoriz per-entry actions trigger, and the entry's market price.
 */
export function InventoryDropdown({
  entries,
  language,
  onPressEntry,
  onPressEntryMenu,
  testID,
}: InventoryDropdownProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.shell,
        { backgroundColor: theme.colors.gray0, borderColor: theme.colors.gray300 },
      ]}
      testID={testID}
    >
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
                          variant="captionMedium"
                        >
                          {/* Figma 5768:24005: "NM · HOLOFOIL · EN" — whole line in caps. */}
                          {summary.toUpperCase()}
                        </AppText>
                        <View style={styles.entryQuantity}>
                          <BoxIso color={theme.colors.gray900} height={14} width={14} />
                          <AppText color="gray900" variant="label">
                            {entry.quantity}
                          </AppText>
                        </View>
                      </View>
                      <Pressable
                        accessibilityLabel="Entry actions"
                        accessibilityRole="button"
                        hitSlop={8}
                        onPress={(event) => {
                          // Measure the "..." so the popover pops anchored to it
                          // (measureInWindow is native-only; fall back to null in
                          // tests / when unavailable so the menu still opens).
                          const target = event?.currentTarget as {
                            measureInWindow?: (
                              cb: (x: number, y: number, width: number, height: number) => void,
                            ) => void;
                          } | null | undefined;
                          if (target && typeof target.measureInWindow === 'function') {
                            target.measureInWindow((x, y, width, height) =>
                              onPressEntryMenu(entry, { height, width, x, y }),
                            );
                          } else {
                            onPressEntryMenu(entry, null);
                          }
                        }}
                        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                        testID={rowTestID ? `${rowTestID}-menu` : undefined}
                      >
                        <MoreHoriz color={theme.colors.gray900} height={24} width={24} />
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
    borderCurve: 'continuous',
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
    borderCurve: 'continuous',
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
  // Figma 6322:8769: gray/50 fill, 8 radius, 5/2 padding, 86 wide.
  pill: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: 4,
    minWidth: 86,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  shell: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: borderWidths.containerRule,
    gap: 12,
    padding: 14,
  },
});

export default InventoryDropdown;

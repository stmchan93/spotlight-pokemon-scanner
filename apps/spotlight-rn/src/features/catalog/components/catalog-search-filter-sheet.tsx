import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { SectionHeader, Text, layout, spacing, useSpotlightTheme } from '@spotlight/design-system';

import {
  CATALOG_SEARCH_FILTER_OPTIONS,
  SEALED_FILTER,
  type CatalogSearchFilter,
} from '@/features/catalog/catalog-search-filter';
import { CatalogSearchFilterChips } from '@/features/catalog/components/catalog-search-filter-chips';
import { InsightsBottomSheet } from '@/features/insights/components/insights-bottom-sheet';

const PRODUCT_OPTIONS = CATALOG_SEARCH_FILTER_OPTIONS.filter((option) => option.value === SEALED_FILTER);
const RARITY_OPTIONS = CATALOG_SEARCH_FILTER_OPTIONS.filter((option) => option.value !== SEALED_FILTER);

type CatalogSearchFilterSheetProps = {
  visible: boolean;
  /** The committed filter — the draft resets to it each time the sheet opens. */
  activeFilter: CatalogSearchFilter | null;
  onApply: (filter: CatalogSearchFilter | null) => void;
  onClose: () => void;
  testID?: string;
};

/**
 * Search's filter button opens this: the same single-select Sealed / rarity
 * model as the results page's chip row (`catalog-search-filter`), grouped into
 * PRODUCT and RARITY. A draft until APPLY; CANCEL and the backdrop discard it.
 * Same CANCEL / title / APPLY header as the Insights "Filter By" sheet.
 */
export function CatalogSearchFilterSheet({
  visible,
  activeFilter,
  onApply,
  onClose,
  testID = 'search-filter-sheet',
}: CatalogSearchFilterSheetProps) {
  const theme = useSpotlightTheme();
  const [draft, setDraft] = useState<CatalogSearchFilter | null>(activeFilter);

  useEffect(() => {
    if (visible) {
      setDraft(activeFilter);
    }
  }, [activeFilter, visible]);

  const toggle = (filter: CatalogSearchFilter) => setDraft((current) => (current === filter ? null : filter));

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
            <Text style={[theme.typography.labelStrong, { color: theme.colors.gray600 }]}>CANCEL</Text>
          </Pressable>
          <Text style={[theme.typography.titleSmall, styles.title, { color: theme.colors.gray900 }]}>
            Filters
          </Text>
          <Pressable
            accessibilityLabel="Apply"
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => onApply(draft)}
            style={styles.headerActionTrailing}
            testID={`${testID}-apply`}
          >
            <Text style={[theme.typography.labelStrong, { color: theme.colors.purple500 }]}>APPLY</Text>
          </Pressable>
        </View>
      }
      onClose={onClose}
      testID={testID}
      visible={visible}
    >
      <View style={styles.body}>
        <View style={styles.group}>
          <SectionHeader size="compact" title="PRODUCT" uppercase />
          <View style={styles.chips}>
            <CatalogSearchFilterChips
              activeFilter={draft}
              onToggle={toggle}
              options={PRODUCT_OPTIONS}
              testIDPrefix={testID}
            />
          </View>
        </View>
        <View style={styles.group}>
          <SectionHeader size="compact" title="RARITY" uppercase />
          <View style={styles.chips}>
            <CatalogSearchFilterChips
              activeFilter={draft}
              onToggle={toggle}
              options={RARITY_OPTIONS}
              testIDPrefix={testID}
            />
          </View>
        </View>
      </View>
    </InsightsBottomSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: spacing.lg,
    paddingBottom: spacing.sm,
    paddingHorizontal: layout.pageGutter,
    paddingTop: spacing.lg,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xxs,
  },
  group: {
    gap: spacing.xs,
  },
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
    paddingHorizontal: layout.pageGutter,
  },
  title: {
    flex: 1,
    textAlign: 'center',
  },
});

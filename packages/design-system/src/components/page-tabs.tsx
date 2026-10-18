import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';
import { spacing } from '../tokens';

export type PageTab<V extends string> = {
  value: V;
  label: string;
};

export type PageTabsSize = 'default' | 'compact';

export type PageTabsProps<V extends string> = {
  tabs: ReadonlyArray<PageTab<V>>;
  value: V;
  onChange: (value: V) => void;
  /** `start` = left-aligned tabs on the page gutter (Figma Events 5476:7154). */
  align?: 'center' | 'start';
  /**
   * `compact` = the Figma "Collection Tabs" rail (5862:6907): 14/500 labels
   * boxed by 16pt side padding, 6pt word-to-underline, inactive gray-500, on a
   * gray-100 hairline. Always left-aligned; pass `scrollable` when the set can
   * outgrow the screen.
   */
  size?: PageTabsSize;
  /** Horizontal scroll instead of squeezing; the rail stays full-bleed. */
  scrollable?: boolean;
  testID?: string;
};

export function PageTabs<V extends string>({
  tabs,
  value,
  onChange,
  align = 'center',
  size = 'default',
  scrollable = false,
  testID,
}: PageTabsProps<V>) {
  const theme = useSpotlightTheme();
  const compact = size === 'compact';

  const row = (
    <View
      style={[
        styles.container,
        compact ? styles.containerCompact : align === 'start' && styles.containerStart,
      ]}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(tab.value)}
            style={({ pressed }) => [
              compact ? styles.tabCompact : styles.tab,
              { opacity: pressed ? 0.7 : 1 },
            ]}
            testID={testID ? `${testID}-tab-${tab.value}` : undefined}
          >
            <Text
              style={[
                theme.typography.bodyMedium,
                compact ? styles.labelCompact : styles.label,
                {
                  // Active tab is medium/gray-900; inactive stays regular-weight
                  // gray-600 (Figma 3184-17337). Compact keeps medium on both and
                  // drops the inactive colour to gray-500 (Figma 5862:6915).
                  fontFamily: selected || compact
                    ? theme.typography.bodyMedium.fontFamily
                    : theme.typography.body.fontFamily,
                  color: selected
                    ? theme.colors.textPrimary
                    : compact
                      ? theme.colors.gray500
                      : theme.colors.gray600,
                },
              ]}
            >
              {tab.label}
            </Text>
            <View
              style={[
                styles.underline,
                {
                  backgroundColor: selected ? theme.colors.textPrimary : 'transparent',
                },
              ]}
              testID={testID ? `${testID}-tab-${tab.value}-underline` : undefined}
            />
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={styles.root} testID={testID}>
      {/* Full-bleed rail behind the tabs. The selected tab's 2px underline sits
          on the same baseline and paints over it. */}
      <View
        style={[
          styles.rail,
          {
            backgroundColor: compact ? theme.colors.gray100 : theme.colors.gray300,
            height: theme.borderWidths.containerRule,
          },
        ]}
        testID={testID ? `${testID}-rail` : undefined}
      />
      {scrollable ? (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          testID={testID ? `${testID}-scroll` : undefined}
        >
          {row}
        </ScrollView>
      ) : (
        row
      )}
    </View>
  );
}

/**
 * Horizontal padding inside each tab, per side — and therefore how far the
 * active underline extends past its label.
 *
 * Figma 3456:3193 gives every tab a fixed box (Collection 86, For Sale 69,
 * Activity 66) with the label centred inside it and the underline spanning the
 * box EDGE TO EDGE. Each box is about 20pt wider than its word, so 10 per side
 * reproduces the drawing while still tracking each label's own width — which
 * fixed pixel widths would not survive a longer label, another locale, or
 * Dynamic Type.
 *
 * It was 4, applied as a negative margin on the underline instead of as padding
 * on the tab. That read as a rule clipped to the word rather than one marking
 * the tab, which is what "the underline should be this long" was about.
 */
const TAB_HORIZONTAL_PADDING = 10;

const styles = StyleSheet.create({
  root: {
    width: '100%',
  },
  // The gray rail runs the full width of the bar, edge to edge — it is not
  // inset by the page gutter, so it reads as one rule under all three tabs.
  rail: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  // Centered row with wide gaps and content-width tabs (Figma 3184-17337), rather
  // than full-width flex:1 tabs. The underline hugs the label width.
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 40,
    backgroundColor: 'transparent',
    // NO top padding: Figma 4157:74399 measures 16 from the sheet's top edge
    // to the label box, and on both consumers (profile + portfolio) that 16 is
    // supplied by the header's white SHEET LIP directly above this bar. Any
    // padding here stacks on top of the lip — 16 + 16 read as ~32 of dead
    // white above "Collection", which is the bug this zero fixes.
    paddingTop: 0,
  },
  // Label lands on the 24pt inset (16 gutter + 8 tab padding in Figma): the
  // container's 14 plus the tab's own 10. Box-to-box gap is 14.
  containerStart: {
    justifyContent: 'flex-start',
    gap: 14,
    paddingHorizontal: 14,
  },
  // Figma 5862:6907: the rail is inset by the page gutter and each tab box
  // carries its own 16 per side, so boxes sit flush (no gap).
  containerCompact: {
    justifyContent: 'flex-start',
    gap: 0,
    paddingHorizontal: spacing.sm,
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    // Bottom-padding-free: the 2px underline IS the tab's bottom edge (Figma
    // 3147:10092 puts it at y26 of a 28px tab), so it lands on the rail.
    // The box the underline fills. The 40pt `gap` sits between these boxes, so
    // the visible space between two words is the gap plus both paddings —
    // matching Figma, where the gap is measured box-to-box, not word-to-word.
    paddingHorizontal: TAB_HORIZONTAL_PADDING,
  },
  tabCompact: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.sm,
  },
  label: {
    textAlign: 'center',
    // 8 word-to-underline (Figma 4067:26938: 18pt text box, underline at y26).
    marginBottom: 8,
    // +1 over the Figma 14 (user request 2026-09-04: tabs read too small).
    fontSize: 15,
    // bodyMedium's 21pt line box floats the 14pt word ~3.5pt below the bar's
    // 16pt padding. Figma's tab box (4067:26807) uses normal leading — 18 here
    // reproduces it, so the word itself sits 16 from the bar's top edge.
    lineHeight: 18,
  },
  // Figma 5862:6911: 14pt label on normal leading, 6 to the underline.
  labelCompact: {
    textAlign: 'center',
    marginBottom: 6,
    lineHeight: 18,
  },
  underline: {
    height: 2,
    // Edge to edge of the tab, exactly as Figma draws it — the tab's own padding
    // is what makes it wider than the word, so there is no negative margin here
    // undoing a layout the tab just established.
    alignSelf: 'stretch',
  },
});

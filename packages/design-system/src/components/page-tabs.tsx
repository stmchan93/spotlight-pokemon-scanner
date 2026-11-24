import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type LayoutRectangle } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';
import { borderWidths, spacing } from '../tokens';

export type PageTab<V extends string> = {
  value: V;
  label: string;
};

export type PageTabsSize = 'default' | 'compact';

/**
 * `underline` = the 2026-11 profile / feed tab rail (Figma 6642:6010): Caption
 * 13 labels (active Medium gray-900 with a 2pt underline, inactive Regular
 * gray-600) on a full-width gray-300 0.5pt hairline, left-packed on the 16
 * gutter with 16 between tabs. One prop for the whole look; `align` and
 * `labelSize` still override it.
 */
export type PageTabsVariant = 'default' | 'underline';

export type PageTabsProps<V extends string> = {
  tabs: ReadonlyArray<PageTab<V>>;
  value: V;
  onChange: (value: V) => void;
  /** See `PageTabsVariant`. Defaults to `default`. */
  variant?: PageTabsVariant;
  /**
   * `start` = left-aligned tabs on the page gutter (Figma Events 5476:7154).
   * `gutter` = the same with 16 inset, 16 between tabs and 12 per tab (Figma Social 6322:8030).
   * `gutter-center` = `gutter` spacing with the row centred (Events).
   * Defaults to `center`, or `gutter` (left-packed, 16 gap) for `variant="underline"`.
   */
  align?: 'center' | 'start' | 'gutter' | 'gutter-center';
  /**
   * `compact` = the Figma "Collection Tabs" rail (5862:6907): Label 14 (same
   * metrics as Body-medium) boxed by 12pt side padding, 6pt word-to-underline,
   * inactive gray-500, on a gray-100 hairline. Always left-aligned; pass
   * `scrollable` when the set can outgrow the screen.
   */
  size?: PageTabsSize;
  /**
   * Horizontal scroll instead of squeezing; the rail stays full-bleed. The
   * selected tab is scrolled into view whenever `value` changes (a swipe or a
   * deep link can select one that is off screen).
   */
  scrollable?: boolean;
  /**
   * `caption` = the Figma profile tab rail (5938:16814): Caption-medium 13 on
   * the active tab, Caption 13 Regular gray-600 on the rest. Default keeps
   * Body-medium 14.
   */
  labelSize?: 'default' | 'caption';
  /** Renders the labels in capitals (Figma COLLECTION / FOR SALE / ACTIVITY). */
  uppercase?: boolean;
  /**
   * `none` = weight + colour alone mark the active tab: no underline, no rail
   * (Figma Social 6597:3462). The underline's box stays, transparent, so the
   * bar keeps its height.
   */
  indicator?: 'underline' | 'none';
  testID?: string;
};

export function PageTabs<V extends string>({
  tabs,
  value,
  onChange,
  variant = 'default',
  align: alignProp,
  size = 'default',
  scrollable = false,
  labelSize: labelSizeProp,
  uppercase = false,
  indicator = 'underline',
  testID,
}: PageTabsProps<V>) {
  const theme = useSpotlightTheme();
  const underlineVariant = variant === 'underline';
  const align = alignProp ?? (underlineVariant ? 'gutter' : 'center');
  const labelSize = labelSizeProp ?? (underlineVariant ? 'caption' : 'default');
  const compact = size === 'compact';
  const captionLabels = labelSize === 'caption';
  const gutterSpacing = align === 'gutter' || align === 'gutter-center';
  const selectedRole = captionLabels ? theme.typography.captionMedium : theme.typography.bodyMedium;
  const inactiveRole = captionLabels ? theme.typography.caption : theme.typography.body;
  const showIndicator = indicator === 'underline';

  // Scrollable only: keep the selected tab inside the viewport.
  const scrollRef = useRef<ScrollView>(null);
  const tabFrames = useRef<Partial<Record<string, LayoutRectangle>>>({});
  const viewport = useRef({ x: 0, width: 0, contentWidth: 0 });
  const revealSelected = (animated: boolean) => {
    const frame = tabFrames.current[value];
    const { x, width, contentWidth } = viewport.current;
    if (!scrollable || !frame || width === 0) {
      return;
    }
    // Start the rail on a TAB BOUNDARY — the leftmost one that still shows the
    // selected tab whole. Only nudging the selected tab into view left the rail
    // wherever a far tab had pushed it: back on WATCHLIST from MARKET
    // ANALYTICS, the first tab stayed sliced to "ON" at the left edge. Now the
    // left edge always shows a whole label and any cut-off falls on the right,
    // where it reads as "more this way".
    const margin = spacing.sm;
    const maxX = Math.max(0, (contentWidth || frame.x + frame.width) - width);
    const fits = (left: number) =>
      frame.x - margin >= left - 0.5 && frame.x + frame.width + margin <= left + width + 0.5;
    const boundaries = [
      0,
      ...Object.values(tabFrames.current)
        .map((tabFrame) => (tabFrame ? tabFrame.x - margin : 0))
        .sort((a, b) => a - b),
    ].map((left) => Math.min(Math.max(0, left), maxX));
    const target = boundaries.find(fits)
      // A tab wider than the rail: centre it.
      ?? Math.min(Math.max(0, frame.x + frame.width / 2 - width / 2), maxX);
    if (Math.abs(target - x) >= 1) {
      scrollRef.current?.scrollTo({ x: target, animated });
    }
  };
  const revealRef = useRef(revealSelected);
  revealRef.current = revealSelected;
  useEffect(() => {
    revealRef.current(true);
  }, [value]);

  const row = (
    <View
      style={[
        styles.container,
        compact
          ? styles.containerCompact
          : align === 'start'
            ? styles.containerStart
            : gutterSpacing && styles.containerGutter,
        !compact && align === 'gutter-center' ? styles.containerGutterCenter : null,
        scrollable ? styles.scrollContent : null,
      ]}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onLayout={scrollable ? (event) => {
              tabFrames.current[tab.value] = event.nativeEvent.layout;
              if (tab.value === value) {
                revealRef.current(false);
              }
            } : undefined}
            onPress={() => onChange(tab.value)}
            style={({ pressed }) => [
              compact ? styles.tabCompact : styles.tab,
              !compact && gutterSpacing ? styles.tabGutter : null,
              { opacity: pressed ? 0.7 : 1 },
            ]}
            testID={testID ? `${testID}-tab-${tab.value}` : undefined}
          >
            {/* The underline tracks the word (plus UNDERLINE_OVERHANG), not the tab's padded box. */}
            <View style={compact ? styles.labelBox : styles.labelBoxFull}>
              <Text
                style={[
                  selectedRole,
                  compact ? styles.labelCompact : styles.label,
                  {
                    // Active tab is medium/gray-900; inactive stays regular-weight
                    // gray-600 (Figma 3184-17337). Compact keeps medium on both and
                    // drops the inactive colour to gray-500 (Figma 5862:6915).
                    fontFamily: selected || compact
                      ? selectedRole.fontFamily
                      : inactiveRole.fontFamily,
                    color: selected
                      ? theme.colors.textPrimary
                      : compact
                        ? theme.colors.gray500
                        : theme.colors.gray600,
                  },
                ]}
              >
                {/* Uppercased in JS, not `textTransform`: iOS measures the line
                    box from the untransformed string and clips the capitals. */}
                {uppercase ? tab.label.toUpperCase() : tab.label}
              </Text>
              <View
                style={[
                  styles.underline,
                  styles.underlineOverhang,
                  {
                    backgroundColor: selected && showIndicator ? theme.colors.textPrimary : 'transparent',
                  },
                ]}
                testID={testID ? `${testID}-tab-${tab.value}-underline` : undefined}
              />
            </View>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View style={styles.root} testID={testID}>
      {/* Full-bleed rail behind the tabs. The selected tab's 2px underline sits
          on the same baseline and paints over it. */}
      {showIndicator ? (
        <View
          style={[
            styles.rail,
            {
              backgroundColor: compact ? theme.colors.gray100 : theme.colors.gray300,
              // The underline variant's rail is Figma's 0.5pt hairline, snapped
              // to whole pixels so it never renders as a 1.5px smear.
              height: underlineVariant ? borderWidths.ruleSnapped : theme.borderWidths.containerRule,
            },
          ]}
          testID={testID ? `${testID}-rail` : undefined}
        />
      ) : null}
      {scrollable ? (
        <ScrollView
          // Grows to the bar's width so a centred set that fits sits centred;
          // a set wider than the screen still scrolls from the start.
          contentContainerStyle={styles.scrollContent}
          horizontal
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={(contentWidth) => {
            viewport.current.contentWidth = contentWidth;
            revealRef.current(false);
          }}
          onLayout={(event) => {
            viewport.current.width = event.nativeEvent.layout.width;
            revealRef.current(false);
          }}
          onScroll={(event) => {
            viewport.current.x = event.nativeEvent.contentOffset.x;
          }}
          ref={scrollRef}
          scrollEventThrottle={16}
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
const TAB_HORIZONTAL_PADDING = 12;
/** The underline runs this far past the word on each side, every size (user, 2026-10-18). */
const UNDERLINE_OVERHANG = 12;

const styles = StyleSheet.create({
  containerGutter: {
    gap: spacing.sm,
    justifyContent: 'flex-start',
    paddingHorizontal: spacing.sm,
  },
  containerGutterCenter: {
    justifyContent: 'center',
  },
  scrollContent: {
    flexGrow: 1,
  },
  tabGutter: {
    paddingHorizontal: spacing.xs,
  },
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
  // carries its own 12 per side, so boxes sit flush (no gap).
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
    paddingHorizontal: spacing.xs,
  },
  // Type is the token's own Body-medium / Body 14 on an 18 line box (Figma
  // 4067:26938: 18pt text box, underline at y26) — the old +1 size bump and
  // lineHeight literal went with the 2026-10-18 type-scale re-cut.
  label: {
    textAlign: 'center',
    // 8 word-to-underline.
    marginBottom: 8,
  },
  // Figma 5862:6911: 14pt label on normal leading, 6 to the underline.
  labelCompact: {
    textAlign: 'center',
    marginBottom: 6,
  },
  labelBox: {
    alignItems: 'stretch',
  },
  labelBoxFull: {
    alignItems: 'stretch',
    alignSelf: 'stretch',
  },
  underlineOverhang: {
    marginHorizontal: -UNDERLINE_OVERHANG,
  },
  underline: {
    height: 2,
    // Edge to edge of the tab, exactly as Figma draws it — the tab's own padding
    // is what makes it wider than the word, so there is no negative margin here
    // undoing a layout the tab just established.
    alignSelf: 'stretch',
  },
});

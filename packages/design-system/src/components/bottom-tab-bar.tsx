import { useRef, type ReactNode } from 'react';
import {
  LayoutAnimation,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import { GlassSurface, isLiquidGlassAvailable } from './glass-surface';
import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';

/**
 * Visible height of THIS component's pill, above the safe-area inset.
 *
 * NOT THE APP'S TAB BAR. `BottomTabBar` is the retired JS nav: the app draws
 * `NativeTabs` (`apps/spotlight-rn/src/app/(tabs)/_layout.tsx`), i.e. UIKit's own
 * `UITabBarController` on iOS and Material's `BottomNavigationView` on Android,
 * and neither is 44 tall.
 *
 * DO NOT USE THIS TO CLEAR THE TAB BAR. Floating affordances that added it sat
 * ~44pt too high on every screen (and cleared a bar that was not there at all on
 * pushed stack screens). The bar's real height is never needed — both platforms
 * already report the room their chrome takes; see
 * `apps/spotlight-rn/src/lib/tab-bar-insets.tsx` for how, per platform.
 *
 * Kept only because this component is still exported. It has no consumer outside
 * this file.
 */
export const bottomTabBarHeight = 44;

export type BottomTabBarItem = {
  key: string;
  label: string;
  icon: ReactNode;
  /**
   * Icon variant shown inside the active-tab highlight when the bar is expanded
   * (Reddit-style: dark filled glyph on a light-grey stadium). Falls back to
   * `icon` when omitted. The collapsed circle always uses `icon`.
   */
  selectedIcon?: ReactNode;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
};

type BottomTabBarProps = {
  items: readonly BottomTabBarItem[];
  bottomInset?: number;
  /**
   * Reddit-style "minimize on scroll": when true the pill morphs down to just
   * the ACTIVE tab (icon-only circle) instead of leaving the screen; scrolling
   * back up restores the full bar. The width change animates via
   * LayoutAnimation. No selected item → the bar simply stays expanded.
   */
  collapsed?: boolean;
  style?: ViewStyle;
  testID?: string;
};

/**
 * Floating bottom navigation. A centered glass "stadium" pill sitting a margin
 * above the screen's bottom edge (not a full-width anchored bar) — the iOS 26
 * Liquid Glass chrome shape. On a real iOS 26 build the pill is the CLEAR
 * native glass material (content genuinely shows through, Reddit-style);
 * everywhere else it's the same solid `canvasElevated` pill. Distinct from
 * `FloatingBottomNav`.
 */
export function BottomTabBar({
  items,
  bottomInset = 0,
  collapsed = false,
  style,
  testID,
}: BottomTabBarProps) {
  const theme = useSpotlightTheme();
  const hasGlass = isLiquidGlassAvailable();

  // Collapse only makes sense down to SOMETHING — with no selected tab (e.g. a
  // pushed utility screen) keep the full bar.
  const activeItem = items.find((item) => item.selected === true) ?? null;
  const isCollapsed = collapsed && activeItem != null;

  // Animate the expand/collapse width morph. configureNext must run before the
  // layout change commits, so it lives in render, gated on an actual change.
  // scaleXY + a slightly longer ease makes the bounds change glide instead of
  // snapping (opacity-only read as an abrupt pop).
  const prevCollapsedRef = useRef(isCollapsed);
  if (prevCollapsedRef.current !== isCollapsed) {
    prevCollapsedRef.current = isCollapsed;
    LayoutAnimation.configureNext(
      LayoutAnimation.create(300, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.scaleXY),
    );
  }

  const visibleItems = isCollapsed && activeItem ? [activeItem] : items;

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.root,
        // Reddit behavior: the expanded pill is centered; the collapsed circle
        // pins to the bottom-LEFT corner.
        isCollapsed
          ? { alignItems: 'flex-start', paddingLeft: theme.layout.bottomNavSideInset }
          : null,
        { paddingBottom: theme.layout.bottomNavBottomInset + bottomInset },
        style,
      ]}
      testID={testID}
    >
      <View
        style={[
          styles.pill,
          // Collapsed = pin to the bottom-LEFT. The pill's default alignSelf is
          // 'center', which would otherwise win over the root's flex-start, so
          // override it here when collapsed.
          isCollapsed ? { alignSelf: 'flex-start' } : null,
          // Real glass: fully transparent base so the clear material does the
          // work (a solid base under glass reads opaque — the pre-Reddit look).
          // Fallback targets keep the solid elevated pill + its shadow.
          hasGlass
            ? null
            : [theme.shadows.card, { backgroundColor: theme.colors.canvasElevated }],
        ]}
      >
        <GlassSurface
          fallbackColor={theme.colors.canvasElevated}
          glassColorScheme="light"
          glassEffectStyle="clear"
          pointerEvents="none"
          style={styles.pillGlass}
          testID={testID ? `${testID}-glass` : undefined}
        />
        <View style={styles.row}>
          {visibleItems.map((item) => {
            const selected = item.selected === true;
            // Reddit-style active treatment: when expanded, the selected tab sits
            // on a light-grey stadium that wraps BOTH the icon AND the label
            // (not a dark icon-only chip). Glyph + text stay dark throughout.
            // Collapsed shows the bare dark icon with no highlight.
            const showHighlight = selected && !isCollapsed;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={item.key}
                onPress={item.onPress}
                style={({ pressed }) => [
                  styles.tab,
                  isCollapsed ? styles.tabCollapsed : null,
                  showHighlight
                    ? [styles.tabSelected, { backgroundColor: theme.colors.gray200 }]
                    : null,
                  { opacity: pressed ? 0.7 : 1 },
                ]}
                testID={item.testID}
              >
                <View style={styles.iconSlot}>
                  {showHighlight ? item.selectedIcon ?? item.icon : item.icon}
                </View>
                {isCollapsed ? null : (
                  <Text
                    style={[
                      selected ? theme.typography.navLabelSelected : theme.typography.navLabel,
                      { color: theme.colors.textPrimary },
                    ]}
                  >
                    {item.label}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  iconSlot: {
    // 22×22 glyph per Figma nav (node 1313:7454 — `size-[22px]`).
    alignItems: 'center',
    flexShrink: 0,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  pill: {
    alignSelf: 'center',
    // Fully rounded ends → the "long oval" / stadium shape.
    borderRadius: 999,
    overflow: 'visible',
  },
  pillGlass: {
    borderRadius: 999,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  root: {
    alignItems: 'center',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  tab: {
    alignItems: 'center',
    flexDirection: 'column',
    flexShrink: 0,
    gap: 2,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  tabSelected: {
    // Light-grey stadium wrapping the active tab's icon + label together
    // (Reddit-style). Fully-rounded ends read as an oval around the column.
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 6,
  },
  tabCollapsed: {
    // Icon-only circle: equalize padding so the collapsed pill reads round.
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});

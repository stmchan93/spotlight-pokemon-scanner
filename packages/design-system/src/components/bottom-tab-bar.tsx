import type { ReactNode } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { GlassSurface } from './glass-surface';
import { useSpotlightTheme } from '../theme';

/**
 * Visible bar height above the safe-area inset. Exported so floating affordances
 * (e.g. the add FAB) can sit a fixed gap above the nav.
 */
export const bottomTabBarHeight = 44;

export type BottomTabBarItem = {
  key: string;
  label: string;
  icon: ReactNode;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
};

type BottomTabBarProps = {
  items: readonly BottomTabBarItem[];
  bottomInset?: number;
  /**
   * iOS 26-style "minimize on scroll" signal (0 = expanded, 1 = hidden). When
   * provided, the floating pill slides down past the screen edge and fades out
   * as the value approaches 1, so it disappears on scroll-down and returns on
   * scroll-up.
   */
  collapseProgress?: Animated.Value;
  style?: ViewStyle;
  testID?: string;
};

/**
 * Floating bottom navigation. A centered glass "stadium" pill sitting a margin
 * above the screen's bottom edge (not a full-width anchored bar) — the iOS 26
 * Liquid Glass chrome shape. On a real iOS 26 build the pill is the native
 * glass material (content refracts under it); everywhere else it's the same
 * solid `canvasElevated` pill. Distinct from `FloatingBottomNav`.
 */
export function BottomTabBar({
  items,
  bottomInset = 0,
  collapseProgress,
  style,
  testID,
}: BottomTabBarProps) {
  const theme = useSpotlightTheme();

  // The pill rests `bottomNavBottomInset` above the safe-area inset; the collapse
  // signal slides it fully off the bottom (its own height + the rest gap + a
  // buffer) and fades it out.
  const restGap = theme.layout.bottomNavBottomInset + bottomInset;
  const collapseDistance = theme.layout.bottomNavHeight + restGap + 24;
  const translateY = collapseProgress
    ? collapseProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [0, collapseDistance],
        extrapolate: 'clamp',
      })
    : 0;
  const opacity = collapseProgress
    ? collapseProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0], extrapolate: 'clamp' })
    : 1;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.root,
        { paddingBottom: restGap, opacity, transform: [{ translateY }] },
        style,
      ]}
      testID={testID}
    >
      <View
        style={[
          styles.pill,
          theme.shadows.card,
          { backgroundColor: theme.colors.canvasElevated },
        ]}
      >
        {/* Real iOS 26 Liquid Glass over the solid base; the base doubles as the
            fallback surface + the thing the shadow casts from. */}
        <GlassSurface
          fallbackColor={theme.colors.canvasElevated}
          glassColorScheme="light"
          pointerEvents="none"
          style={styles.pillGlass}
          testID={testID ? `${testID}-glass` : undefined}
        />
        <View style={styles.row}>
          {items.map((item) => {
            const selected = item.selected === true;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={item.key}
                onPress={item.onPress}
                style={({ pressed }) => [styles.tab, { opacity: pressed ? 0.7 : 1 }]}
                testID={item.testID}
              >
                <View style={styles.iconSlot}>{item.icon}</View>
                <Text
                  style={[
                    selected ? theme.typography.navLabelSelected : theme.typography.navLabel,
                    { color: theme.colors.textPrimary },
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </Animated.View>
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
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
});

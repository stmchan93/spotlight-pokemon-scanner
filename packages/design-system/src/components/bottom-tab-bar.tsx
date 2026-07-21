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
 * Visible bar height above the safe-area inset (Figma 1277-7732: 44 = 4px top
 * pad + a 40px nav-item row). Exported so floating affordances (e.g. the add
 * FAB) can sit a fixed gap above the bar.
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
   * provided, the bar slides down by its full height and fades out as the value
   * approaches 1, so it disappears on scroll-down and returns on scroll-up.
   */
  collapseProgress?: Animated.Value;
  style?: ViewStyle;
  testID?: string;
};

/**
 * Anchored bottom navigation bar. Sits flush against the screen's bottom
 * edge, full screen width, with an icon-over-label layout per tab. Distinct
 * from `FloatingBottomNav`, which renders a pill floating above content.
 */
export function BottomTabBar({
  items,
  bottomInset = 0,
  collapseProgress,
  style,
  testID,
}: BottomTabBarProps) {
  const theme = useSpotlightTheme();

  // Slide the whole bar (visible height + safe-area inset) below the screen and
  // fade it as the collapse signal climbs to 1; absent the signal it's static.
  const collapseDistance = bottomTabBarHeight + bottomInset;
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
      style={[
        styles.bar,
        {
          opacity,
          paddingBottom: bottomInset,
          transform: [{ translateY }],
        },
        style,
      ]}
      testID={testID}
    >
      {/*
        iOS 26 → real Liquid Glass material; every other target → the exact
        solid `canvasElevated` bar we ship today. Sits behind the tab row as an
        absolute-fill layer so the row's content still sizes the bar height.
      */}
      <GlassSurface
        fallbackColor={theme.colors.canvasElevated}
        glassColorScheme="light"
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
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
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  iconSlot: {
    // 22×22 glyph per Figma nav (node 1313:7454 — `size-[22px]`).
    alignItems: 'center',
    flexShrink: 0,
    height: 22,
    justifyContent: 'center',
    width: 22,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 32,
    justifyContent: 'center',
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  tab: {
    alignItems: 'center',
    flexDirection: 'column',
    flexShrink: 0,
    gap: 2,
    // 40 + the row's 4px top padding = 44px bar (Figma 1277-7732).
    height: 40,
    justifyContent: 'center',
    width: 59,
  },
});

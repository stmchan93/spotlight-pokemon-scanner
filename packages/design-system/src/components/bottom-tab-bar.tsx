import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

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
  style?: ViewStyle;
  testID?: string;
};

/**
 * Anchored bottom navigation bar. Sits flush against the screen's bottom
 * edge with a 1px top border, full screen width, and an icon-over-label
 * layout per tab. Distinct from `FloatingBottomNav`, which renders a pill
 * floating above content.
 */
export function BottomTabBar({
  items,
  bottomInset = 0,
  style,
  testID,
}: BottomTabBarProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.canvasElevated,
          borderTopColor: theme.colors.gray100,
          paddingBottom: bottomInset,
        },
        style,
      ]}
      testID={testID}
    >
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
  );
}

const styles = StyleSheet.create({
  bar: {
    borderTopWidth: 1,
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

import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { useSpotlightTheme } from '../theme';

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
          borderTopColor: theme.colors.searchBorder,
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
                  selected ? theme.typography.headline : theme.typography.body,
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
    alignItems: 'center',
    height: 24,
    justifyContent: 'center',
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingTop: 12,
    paddingBottom: 8,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    gap: 4,
    justifyContent: 'center',
  },
});

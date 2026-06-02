import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';

import { useSpotlightTheme } from '../theme';
import { GlassSurface } from './glass-surface';

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
  /**
   * Drives the collapse morph. `0` = expanded full bar, `1` = collapsed to a
   * centered pill showing only the active tab's icon. Omit for a static,
   * fully-expanded bar.
   */
  collapseProgress?: Animated.Value;
};

const HORIZONTAL_INSET = 16;
const BAR_RADIUS = 28;
const COLLAPSED_SIZE = 56;

/**
 * Floating "Liquid Glass" bottom navigation bar. Renders a frosted, rounded
 * shell ({@link GlassSurface}) that floats above the safe area with an
 * icon-over-label layout per tab and a brand-tinted active-tab indicator.
 *
 * When `collapseProgress` is supplied it cross-fades between the full bar and
 * a centered pill showing only the active tab's icon (native-driver friendly:
 * opacity + scale only).
 */
export function BottomTabBar({
  items,
  bottomInset = 0,
  style,
  testID,
  collapseProgress,
}: BottomTabBarProps) {
  const theme = useSpotlightTheme();

  const activeItem = items.find((item) => item.selected === true) ?? items[0];

  // Track collapse phase from the driver so we can flip pointerEvents on the
  // hidden layer (keeps touches going to the visible shell). Defaults to
  // expanded when no driver is supplied.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!collapseProgress) {
      setCollapsed(false);
      return;
    }
    const id = collapseProgress.addListener(({ value }) => {
      setCollapsed(value >= 0.5);
    });
    return () => collapseProgress.removeListener(id);
  }, [collapseProgress]);

  // Static progress (0) when no driver, so interpolations are inert.
  const staticProgress = useRef(new Animated.Value(0)).current;
  const progress = collapseProgress ?? staticProgress;

  const fullOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  });
  const fullScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.96],
  });
  const pillOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const pillScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.96, 1],
  });

  const shadowStyle: ViewStyle = {
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { bottom: bottomInset }]}
    >
      {/* Full bar shell */}
      <Animated.View
        pointerEvents={collapsed ? 'none' : 'auto'}
        style={[
          styles.fullShell,
          shadowStyle,
          { opacity: fullOpacity, transform: [{ scale: fullScale }] },
          style,
        ]}
        testID={testID}
      >
        <GlassSurface style={styles.glass}>
          <View style={styles.row}>
            {items.map((item) => {
              const selected = item.selected === true;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  key={item.key}
                  onPress={item.onPress}
                  style={({ pressed }) => [
                    styles.tab,
                    { opacity: pressed ? 0.7 : 1 },
                  ]}
                  testID={item.testID}
                >
                  <View
                    style={[
                      styles.iconSlot,
                      selected && {
                        backgroundColor: theme.colors.surfaceMuted,
                      },
                    ]}
                    testID={
                      selected && item.testID
                        ? `${item.testID}-indicator`
                        : undefined
                    }
                  >
                    {item.icon}
                  </View>
                  <Text
                    style={[
                      theme.typography.navLabel,
                      {
                        color: selected
                          ? theme.colors.brandPurple
                          : theme.colors.textPrimary,
                      },
                    ]}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </GlassSurface>
      </Animated.View>

      {/* Collapsed pill — active icon only */}
      {activeItem ? (
        <Animated.View
          pointerEvents={collapsed ? 'auto' : 'none'}
          style={[
            styles.pillShell,
            shadowStyle,
            { opacity: pillOpacity, transform: [{ scale: pillScale }] },
          ]}
          testID={testID ? `${testID}-collapsed` : undefined}
        >
          <GlassSurface style={styles.pillGlass}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: true }}
              onPress={activeItem.onPress}
              style={({ pressed }) => [
                styles.pillTab,
                { opacity: pressed ? 0.7 : 1 },
              ]}
              testID={
                activeItem.testID ? `${activeItem.testID}-collapsed` : undefined
              }
            >
              <View
                style={[
                  styles.iconSlot,
                  { backgroundColor: theme.colors.surfaceMuted },
                ]}
              >
                {activeItem.icon}
              </View>
            </Pressable>
          </GlassSurface>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fullShell: {
    borderRadius: BAR_RADIUS,
    left: HORIZONTAL_INSET,
    position: 'absolute',
    right: HORIZONTAL_INSET,
  },
  glass: {
    borderRadius: BAR_RADIUS,
    overflow: 'hidden',
  },
  host: {
    left: 0,
    position: 'absolute',
    right: 0,
  },
  iconSlot: {
    alignItems: 'center',
    borderRadius: 14,
    flexShrink: 0,
    height: 28,
    justifyContent: 'center',
    width: 40,
  },
  pillGlass: {
    alignItems: 'center',
    borderRadius: COLLAPSED_SIZE / 2,
    height: COLLAPSED_SIZE,
    justifyContent: 'center',
    overflow: 'hidden',
    width: COLLAPSED_SIZE,
  },
  pillShell: {
    alignSelf: 'center',
    borderRadius: COLLAPSED_SIZE / 2,
    position: 'absolute',
  },
  pillTab: {
    alignItems: 'center',
    height: COLLAPSED_SIZE,
    justifyContent: 'center',
    width: COLLAPSED_SIZE,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 24,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tab: {
    alignItems: 'center',
    flexDirection: 'column',
    flexShrink: 0,
    gap: 4,
    justifyContent: 'center',
  },
});

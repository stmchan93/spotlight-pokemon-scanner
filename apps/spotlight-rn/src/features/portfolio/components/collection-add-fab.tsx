import { useRouter } from 'expo-router';
import { Search } from 'iconoir-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import {
  GlassSurface,
  isLiquidGlassAvailable,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { useFloatingAffordanceBottom } from '@/lib/tab-bar-insets';

type CollectionAddFabProps = {
  onPress?: () => void;
  testID?: string;
};

/**
 * Floating catalog-search button at the bottom-right (Figma 3049-7289): a
 * light circle with a magnifier glyph — replaces the old purple `+` FAB (same
 * position and destination, /catalog/search). Gets the app's Reddit-style
 * glass chrome treatment: clear Liquid Glass on real iOS 26, the solid
 * elevated circle everywhere else.
 */
export function CollectionAddFab({
  onPress,
  testID = 'collection-add-fab',
}: CollectionAddFabProps) {
  const router = useRouter();
  const theme = useSpotlightTheme();
  const hasGlass = isLiquidGlassAvailable();

  const handlePress = () => {
    if (onPress) {
      onPress();
      return;
    }
    router.push('/catalog/search' as never);
  };

  // Sit one gap above the bottom chrome. This used to add the design system's
  // `bottomTabBarHeight` (44) — the RETIRED JS nav pill's height, not the
  // `NativeTabs` bar the app draws — which floated it ~44pt too high. Insights is
  // this component's only host and is a PUSHED stack screen with no bar at all,
  // so it was clearing chrome that does not exist. See `@/lib/tab-bar-insets`.
  const bottom = useFloatingAffordanceBottom();

  return (
    <Pressable
      accessibilityLabel="Search the card catalog"
      accessibilityRole="button"
      hitSlop={12}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.fab,
        hasGlass
          ? null
          : [styles.fabShadow, { backgroundColor: theme.colors.canvasElevated }],
        { bottom },
        pressed ? styles.fabPressed : null,
      ]}
      testID={testID}
    >
      <GlassSurface
        fallbackColor={theme.colors.canvasElevated}
        glassColorScheme="auto"
        glassEffectStyle="regular"
        pointerEvents="none"
        style={styles.fabGlass}
      />
      <View pointerEvents="none">
        <Search color={theme.colors.textPrimary} height={22} width={22} strokeWidth={1.8} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    alignItems: 'center',
    borderRadius: 999,
    height: 48,
    justifyContent: 'center',
    position: 'absolute',
    right: 16,
    width: 48,
  },
  fabGlass: {
    borderRadius: 999,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  fabPressed: {
    opacity: 0.7,
  },
  fabShadow: {
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
  },
});

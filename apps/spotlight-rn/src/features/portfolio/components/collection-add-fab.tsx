import { useRouter } from 'expo-router';
import { Search } from 'iconoir-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  GlassSurface,
  bottomTabBarHeight,
  isLiquidGlassAvailable,
  useSpotlightTheme,
} from '@spotlight/design-system';

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
  const insets = useSafeAreaInsets();
  const theme = useSpotlightTheme();
  const hasGlass = isLiquidGlassAvailable();

  const handlePress = () => {
    if (onPress) {
      onPress();
      return;
    }
    router.push('/catalog/search' as never);
  };

  // Sit 28px above the Collection/Scan/Events nav bar (the bar is
  // bottomTabBarHeight tall and padded by the bottom safe-area inset).
  const bottom = Math.max(insets.bottom, 0) + bottomTabBarHeight + 28;

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
        glassColorScheme="light"
        glassEffectStyle="clear"
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

import { useRouter } from 'expo-router';
import { Plus } from 'iconoir-react-native';
import { Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { bottomTabBarHeight, colors } from '@spotlight/design-system';

type CollectionAddFabProps = {
  onPress?: () => void;
  testID?: string;
};

export function CollectionAddFab({
  onPress,
  testID = 'collection-add-fab',
}: CollectionAddFabProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const handlePress = () => {
    if (onPress) {
      onPress();
      return;
    }
    router.push('/catalog/search' as never);
  };

  // Sit exactly 16px above the Collection/Scan/Events nav bar (the bar is
  // bottomTabBarHeight tall and padded by the bottom safe-area inset).
  const bottom = Math.max(insets.bottom, 0) + bottomTabBarHeight + 16;

  return (
    <Pressable
      accessibilityLabel="Add card to collection"
      accessibilityRole="button"
      hitSlop={12}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.fab,
        { backgroundColor: colors.brand, bottom },
        pressed ? styles.fabPressed : null,
      ]}
      testID={testID}
    >
      <Plus color={colors.gray900} height={24} width={24} strokeWidth={2.4} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    alignItems: 'center',
    borderRadius: 12,
    elevation: 8,
    height: 40,
    justifyContent: 'center',
    position: 'absolute',
    right: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 12,
    width: 40,
  },
  fabPressed: {
    opacity: 0.88,
  },
});

import { useRouter } from 'expo-router';
import { Plus } from 'iconoir-react-native';
import { Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, useSpotlightTheme } from '@spotlight/design-system';

type CollectionAddFabProps = {
  onPress?: () => void;
  testID?: string;
};

export function CollectionAddFab({
  onPress,
  testID = 'collection-add-fab',
}: CollectionAddFabProps) {
  const router = useRouter();
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const handlePress = () => {
    if (onPress) {
      onPress();
      return;
    }
    router.push('/catalog/search' as never);
  };

  const bottom =
    theme.layout.bottomNavHeight
    + theme.layout.bottomNavBottomInset
    + Math.max(insets.bottom - 8, 0)
    + 16;

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

import { Pressable, StyleSheet } from 'react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

type EditDoneButtonProps = {
  onPress: () => void;
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * "Done" pill that exits an edit / multi-select mode (Figma 1874:18766): a
 * gray-50 fully-rounded 36px pill with a 14px SemiBold purple-500 label. Shared
 * by the Collection and Wishlist headers so the two read identically.
 */
export function EditDoneButton({
  onPress,
  accessibilityLabel = 'Done editing',
  testID,
}: EditDoneButtonProps) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.88 : 1 },
      ]}
      testID={testID}
    >
      <Text style={[theme.typography.bodyStrong, styles.label, { color: theme.colors.purple500 }]}>
        Done
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 14,
    lineHeight: 21,
  },
  pill: {
    alignItems: 'center',
    borderRadius: 999,
    height: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
});

export default EditDoneButton;

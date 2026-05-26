import { IconChevronDown } from '@tabler/icons-react-native';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, textStyles } from '@spotlight/design-system';

export function ScanTargetPill({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Scanning for ${label}. Change scan target`}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      testID={testID}
    >
      <Text style={styles.label}>{label}</Text>
      <IconChevronDown color={colors.gray0} size={16} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: {
    ...textStyles.control,
    color: colors.gray0,
  },
  pill: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  pillPressed: {
    opacity: 0.85,
  },
});

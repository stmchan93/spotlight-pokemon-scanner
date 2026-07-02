import { IconChevronDown } from '@tabler/icons-react-native';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, textStyles } from '@spotlight/design-system';

import { RoundFlag } from './round-flag';

export function ScanTargetPill({
  label,
  flag,
  onPress,
  testID,
}: {
  label: string;
  /** Round language flag shown after the label (Figma 2302:28968). */
  flag?: 'en' | 'jp';
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
      {flag ? <RoundFlag language={flag} size={13} /> : null}
      <IconChevronDown color={colors.gray0} size={20} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: {
    // Figma 1180-1278 "Label" — Plus Jakarta Sans Medium 13 (not the default
    // 15/SemiBold control role), white over the translucent pill.
    ...textStyles.label,
    color: colors.gray0,
  },
  pill: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    height: 36,
    paddingHorizontal: 16,
  },
  pillPressed: {
    opacity: 0.85,
  },
});

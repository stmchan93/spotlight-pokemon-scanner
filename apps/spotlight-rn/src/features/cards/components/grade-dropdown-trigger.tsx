import { Pressable, StyleSheet } from 'react-native';
import { NavArrowDown } from 'iconoir-react-native';

import { Text, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

// Short labels ("NEAR MINT", "PSA 10") keep the Figma 160pt shell; longer ones
// grow past it instead of clipping.
const TRIGGER_MIN_WIDTH = 160;

type GradeDropdownTriggerProps = {
  /** Section title ("Condition" / "Grade"), used for the a11y label. */
  title: string;
  label: string | null;
  onPress: () => void;
  /** Label + chevron color. */
  color: string;
  testID?: string;
};

/**
 * The Condition/Grade dropdown chip shared by the PDP owned-copy edit fields
 * and the Add-to-Collection sheet. Content-sized: the full label always fits,
 * and only a label wider than the row (tiny phones) ellipsizes at the end.
 */
export function GradeDropdownTrigger({ title, label, onPress, color, testID }: GradeDropdownTriggerProps) {
  const theme = useSpotlightTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${label ?? 'Select'}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.trigger,
        { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.9 : 1 },
      ]}
      testID={testID}
    >
      <Text
        ellipsizeMode="tail"
        numberOfLines={1}
        style={[theme.typography.caption, styles.label, { color }]}
        testID={testID ? `${testID}-label` : undefined}
      >
        {(label ?? 'Select').toUpperCase()}
      </Text>
      <NavArrowDown color={color} height={24} style={styles.chevron} width={24} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chevron: {
    flexShrink: 0,
  },
  label: {
    flexShrink: 1,
  },
  trigger: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: spacing.xxs,
    justifyContent: 'space-between',
    maxWidth: '100%',
    minHeight: spacing.xxl,
    minWidth: TRIGGER_MIN_WIDTH,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxxs,
  },
});

export default GradeDropdownTrigger;

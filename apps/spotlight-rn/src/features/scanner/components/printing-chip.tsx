import { IconChevronDown } from '@tabler/icons-react-native';
import { Pressable, StyleSheet } from 'react-native';
import { Pressable as ArenaPressable } from 'react-native-gesture-handler';

import { Text, colors, textStyles } from '@spotlight/design-system';

/** Row-chip geometry shared with the tray's CHANGE chip (Figma 5085:10671). */
export const printingChipHeight = 18;

export type PrintingChipProps = {
  /** e.g. "Holofoil" — see `printingChipLabel`. */
  label: string;
  /**
   * True once the user picked the printing; false while the chip
   * shows the catalog DEFAULT the price is based on. A guess renders muted
   * (gray-600) so it reads as a guess; a choice renders gray-900.
   */
  confirmed: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  /**
   * Tray rows live inside the tray's gesture arena and must use
   * gesture-handler's Pressable (see `ArenaPressable` in scanner-screen);
   * everything else uses the plain RN Pressable.
   */
  arena?: boolean;
  testID?: string;
};

/**
 * The printing the shown price assumes, one tap from the price
 * sheet. Reads "Holofoil · NM" (chosen) or "Default · NM" (the catalog's own
 * default, unconfirmed). Kept the height of its sibling row chips so it adds
 * no row height to the windowed tray.
 */
export function PrintingChip({
  accessibilityLabel,
  arena = false,
  confirmed,
  label,
  onPress,
  testID,
}: PrintingChipProps) {
  const Touchable = arena ? ArenaPressable : Pressable;
  const color = confirmed ? colors.gray900 : colors.gray600;
  return (
    <Touchable
      accessibilityLabel={accessibilityLabel ?? `Printing: ${label}. Change`}
      accessibilityRole="button"
      accessibilityState={{ selected: confirmed }}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, pressed ? styles.chipPressed : null]}
      testID={testID}
    >
      <Text numberOfLines={1} style={[styles.label, { color }]} testID={testID ? `${testID}-label` : undefined}>
        {label}
      </Text>
      <IconChevronDown color={color} size={11} strokeWidth={2.4} />
    </Touchable>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.gray50,
    borderCurve: 'continuous',
    borderRadius: 4,
    flexDirection: 'row',
    gap: 2,
    height: printingChipHeight,
    maxWidth: '100%',
    paddingLeft: 5,
    paddingRight: 3,
  },
  chipPressed: {
    opacity: 0.7,
  },
  label: {
    ...textStyles.overline,
    flexShrink: 1,
  },
});

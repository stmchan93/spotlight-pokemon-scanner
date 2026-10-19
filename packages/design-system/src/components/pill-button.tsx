import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';
import { radii, spacing } from '../tokens';

export type PillButtonTone = 'default' | 'filter' | 'filled' | 'soft' | 'option';

type PillButtonProps = {
  label: string;
  /**
   * Optional icon rendered before the label (Figma Insights chips: the Likes
   * heart, the Price sort arrows). The caller owns the icon color so it can
   * follow the selected state.
   */
  leading?: ReactNode;
  minWidth?: number;
  onPress?: () => void;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * Visual tone. 'default' is the brand-yellow pill used in chart range pills,
   * filter modal etc. 'filter' is the chip used in the Collection / Sales chip
   * rows: a white pill when inactive and a solid black (gray900) pill with a
   * white label when selected (Figma — selected chips read black, not purple).
   * 'filled' is the borderless 'filter' chip (Figma 5722:21551): gray-100 fill
   * when inactive, the same black pill when selected. Collection / Insights /
   * Wishlist chip rows.
   * 'soft' is the borderless gray-50 chip used inside empty states (Figma
   * "Scan to add", 3370:4175) — a low-emphasis suggestion, not a toggle, so it
   * ignores `selected`.
   * 'option' is the compact printing/variant chip from the scanner's change-card
   * list (Figma 5085:10859/10861): gray-50 when unselected, purple-500 with a
   * white label when selected. Sized for a dense horizontal rail, not a
   * standalone control.
   */
  tone?: PillButtonTone;
  /**
   * Label role for the 'filter' / 'filled' chips. 'label' (default) is Label 14;
   * 'caption' is Caption 13 Regular — the Figma "Secondary" filter chip
   * (5938:16830) on Collection / Wishlist / Insights.
   */
  labelRole?: 'label' | 'caption';
  /**
   * Renders the label in capitals (Figma filter chips read ALL / LIKES / A-Z).
   * Applied to the string, not via `textTransform`: iOS measures the line box
   * from the untransformed text, so capitals clip inside a content-sized pill.
   */
  uppercase?: boolean;
};

export function PillButton({
  label,
  labelRole = 'label',
  leading,
  minWidth,
  onPress,
  selected = false,
  style,
  testID,
  tone = 'default',
  uppercase = false,
}: PillButtonProps) {
  const theme = useSpotlightTheme();

  const isFilterChip = tone === 'filter' || tone === 'filled';

  const containerStyle = isFilterChip
    ? styles.filterContainer
    : tone === 'soft'
      ? styles.softContainer
      : tone === 'option'
        ? styles.optionContainer
        : styles.container;

  // Figma: chips are Label 14, the compact option chip Caption-medium 13,
  // everything else Body-medium 14.
  const labelStyle = isFilterChip
    ? (labelRole === 'caption' ? theme.typography.caption : theme.typography.label)
    : tone === 'option'
      ? theme.typography.captionMedium
      : theme.typography.bodyMedium;

  const backgroundColor = tone === 'filter'
    ? (selected ? theme.colors.gray900 : theme.colors.gray0)
    : tone === 'filled'
      ? (selected ? theme.colors.gray900 : theme.colors.gray100)
    : tone === 'soft'
      ? theme.colors.gray50
      : tone === 'option'
        ? (selected ? theme.colors.purple500 : theme.colors.gray50)
        : (selected ? theme.colors.brand : theme.colors.field);

  const borderColor = tone === 'filter'
    ? (selected ? theme.colors.gray900 : theme.colors.gray300)
    : tone === 'filled'
      ? (selected ? theme.colors.gray900 : theme.colors.gray100)
    : tone === 'soft'
      ? 'transparent'
      : tone === 'option'
        ? (selected ? theme.colors.purple500 : theme.colors.gray50)
        : (selected ? theme.colors.brand : theme.colors.outlineSubtle);

  const labelColor = isFilterChip
    ? (selected ? theme.colors.gray0 : theme.colors.gray900)
    : tone === 'soft'
      ? theme.colors.gray900
      : tone === 'option'
        ? (selected ? theme.colors.gray0 : theme.colors.gray900)
        : theme.colors.textPrimary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        containerStyle,
        {
          minWidth,
          backgroundColor,
          borderColor,
          opacity: pressed ? 0.88 : 1,
        },
        style,
      ]}
    >
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <Text
        style={[
          labelStyle,
          styles.label,
          {
            color: labelColor,
          },
        ]}
      >
        {uppercase ? label.toUpperCase() : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  filterContainer: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  label: {
    textAlign: 'center',
  },
  // Figma empty-state "Scan to add" chip (3370:4175): gray-50 fill, radius 8,
  // 12/6 padding, 8 gap, no stroke. Borderless, so the width is set by the
  // content rather than by a stroked shell.
  softContainer: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: 0,
    flexDirection: 'row',
    gap: spacing.xxs,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: 6,
  },
  leading: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Figma scanner "Option Item" (5085:10859): radius 8, 8/4 padding,
  // Caption-medium label — a compact chip that sits in a scrolling rail under
  // a card row.
  optionContainer: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xxxs,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxs,
    paddingVertical: spacing.xxxs,
  },
});

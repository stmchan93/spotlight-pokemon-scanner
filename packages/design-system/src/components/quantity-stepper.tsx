import { Minus, Plus } from 'iconoir-react-native';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { radii, spacing } from '../tokens';
import { AppText } from './app-text';
import { IconButton } from './icon-button';
import { Text } from './scaled-text';

export type QuantityStepperVariant = 'pill' | 'tile';

type QuantityStepperProps = {
  decrementLabel?: string;
  disabled?: boolean;
  /** Formats the readout, e.g. "QTY: 1" on the set page tile. */
  formatValue?: (value: number) => string;
  incrementLabel?: string;
  max?: number;
  min?: number;
  onChange: (value: number) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  value: number;
  /**
   * 'pill' (default): the 40pt rounded stepper with ghost icon buttons.
   * 'tile': the full-width gray-100 bar under a card-grid tile, − and + at the
   * ends and the readout centred (set page, Figma 6425:3344).
   */
  variant?: QuantityStepperVariant;
};

const TILE_ICON_SIZE = 10;

export function QuantityStepper({
  decrementLabel = 'Decrease quantity',
  disabled = false,
  formatValue,
  incrementLabel = 'Increase quantity',
  max,
  min = 0,
  onChange,
  style,
  testID,
  value,
  variant = 'pill',
}: QuantityStepperProps) {
  const theme = useSpotlightTheme();
  const canDecrement = !disabled && value > min;
  const canIncrement = !disabled && (max === undefined || value < max);
  const readout = formatValue ? formatValue(value) : String(value);
  const decrement = () => onChange(Math.max(min, value - 1));
  const increment = () => onChange(max === undefined ? value + 1 : Math.min(max, value + 1));

  if (variant === 'tile') {
    const iconColor = (enabled: boolean) => (enabled ? theme.colors.gray900 : theme.colors.gray400);
    return (
      <View style={[styles.tile, { backgroundColor: theme.colors.gray100 }, style]} testID={testID}>
        <Pressable
          accessibilityLabel={decrementLabel}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canDecrement }}
          disabled={!canDecrement}
          hitSlop={spacing.xs}
          onPress={decrement}
          testID={testID ? `${testID}-decrement` : undefined}
        >
          <Minus color={iconColor(canDecrement)} height={TILE_ICON_SIZE} width={TILE_ICON_SIZE} />
        </Pressable>
        <Text
          style={[theme.typography.stepperLabel, { color: theme.colors.gray900 }]}
          testID={testID ? `${testID}-value` : undefined}
        >
          {readout}
        </Text>
        <Pressable
          accessibilityLabel={incrementLabel}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canIncrement }}
          disabled={!canIncrement}
          hitSlop={spacing.xs}
          onPress={increment}
          testID={testID ? `${testID}-increment` : undefined}
        >
          <Plus color={iconColor(canIncrement)} height={TILE_ICON_SIZE} width={TILE_ICON_SIZE} />
        </Pressable>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.stepper,
        {
          backgroundColor: theme.colors.field,
          borderColor: theme.colors.outlineSubtle,
          borderCurve: 'continuous',
          borderRadius: theme.radii.pill,
        },
        style,
      ]}
      testID={testID}
    >
      <IconButton
        accessibilityLabel={decrementLabel}
        disabled={!canDecrement}
        onPress={decrement}
        size={32}
        testID={testID ? `${testID}-decrement` : undefined}
        variant="ghost"
      >
        <AppText variant="titleMedium">-</AppText>
      </IconButton>
      <AppText style={styles.value} testID={testID ? `${testID}-value` : undefined} variant="bodyMedium">
        {readout}
      </AppText>
      <IconButton
        accessibilityLabel={incrementLabel}
        disabled={!canIncrement}
        onPress={increment}
        size={32}
        testID={testID ? `${testID}-increment` : undefined}
        variant="ghost"
      >
        <AppText variant="titleMedium">+</AppText>
      </IconButton>
    </View>
  );
}

const styles = StyleSheet.create({
  stepper: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 2,
    minHeight: 40,
    paddingHorizontal: 4,
  },
  // Figma 6425:3344: gray-100 bar, radius-4, 10/6 padding, ends pinned apart.
  tile: {
    alignItems: 'center',
    alignSelf: 'stretch',
    borderCurve: 'continuous',
    borderRadius: radii.xs,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  value: {
    minWidth: 28,
    textAlign: 'center',
  },
});

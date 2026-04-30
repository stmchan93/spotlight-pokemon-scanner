import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';
import { IconButton } from './icon-button';

type QuantityStepperProps = {
  decrementLabel?: string;
  disabled?: boolean;
  incrementLabel?: string;
  max?: number;
  min?: number;
  onChange: (value: number) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  value: number;
};

export function QuantityStepper({
  decrementLabel = 'Decrease quantity',
  disabled = false,
  incrementLabel = 'Increase quantity',
  max,
  min = 0,
  onChange,
  style,
  testID,
  value,
}: QuantityStepperProps) {
  const theme = useSpotlightTheme();
  const canDecrement = !disabled && value > min;
  const canIncrement = !disabled && (max === undefined || value < max);

  return (
    <View
      style={[
        styles.stepper,
        {
          backgroundColor: theme.colors.field,
          borderColor: theme.colors.outlineSubtle,
          borderRadius: theme.radii.pill,
        },
        style,
      ]}
      testID={testID}
    >
      <IconButton
        accessibilityLabel={decrementLabel}
        disabled={!canDecrement}
        onPress={() => onChange(Math.max(min, value - 1))}
        size={32}
        testID={testID ? `${testID}-decrement` : undefined}
        variant="ghost"
      >
        <AppText variant="titleCompact">-</AppText>
      </IconButton>
      <AppText style={styles.value} testID={testID ? `${testID}-value` : undefined} variant="bodyStrong">
        {value}
      </AppText>
      <IconButton
        accessibilityLabel={incrementLabel}
        disabled={!canIncrement}
        onPress={() => onChange(max === undefined ? value + 1 : Math.min(max, value + 1))}
        size={32}
        testID={testID ? `${testID}-increment` : undefined}
        variant="ghost"
      >
        <AppText variant="titleCompact">+</AppText>
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
  value: {
    minWidth: 28,
    textAlign: 'center',
  },
});

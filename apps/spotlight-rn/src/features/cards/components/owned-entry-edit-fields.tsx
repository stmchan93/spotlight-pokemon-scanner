import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowDown, ArrowUp, Minus, NavArrowDown, Plus } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

type OwnedEntryEditFieldsProps = {
  /** Section title for the grade/condition selector ("Condition"). */
  gradeTitle: string;
  gradeLabel: string | null;
  onOpenGradePicker: () => void;
  quantity: number;
  onIncrement: () => void;
  onDecrement: () => void;
  /** Raw text in the Cost Basis input (per-unit dollars, no "$"). */
  costBasisText: string;
  onChangeCostBasisText: (text: string) => void;
  /** Per-unit gain (current market − cost basis); null hides the pill. */
  gainPerUnit: number | null;
  /** Pre-formatted absolute gain, e.g. "$100.16". */
  gainLabel: string | null;
  /** Pre-formatted "Updated <date>" line, or null. */
  updatedLabel?: string | null;
  testID?: string;
};

/**
 * Inline edit controls for an OWNED card on the PDP (Figma 1874:21729 / 21488):
 * a Condition/Grade dropdown, a Quantity stepper, and a Cost Basis row — a
 * bottom-ruled "$" input with a gain pill (Figma 1874:22846) and an italic
 * "Updated" stamp. Presentational; the screen owns state + hosts the grade
 * picker that `onOpenGradePicker` opens.
 */
export function OwnedEntryEditFields({
  gradeTitle,
  gradeLabel,
  onOpenGradePicker,
  quantity,
  onIncrement,
  onDecrement,
  costBasisText,
  onChangeCostBasisText,
  gainPerUnit,
  gainLabel,
  updatedLabel,
  testID = 'owned-entry-edit',
}: OwnedEntryEditFieldsProps) {
  const theme = useSpotlightTheme();
  const gainPositive = (gainPerUnit ?? 0) >= 0;
  const gainSurface = gainPositive ? theme.colors.deltaUpSurface : theme.colors.deltaDownSurface;
  const gainColor = gainPositive ? theme.colors.deltaUpText : theme.colors.deltaDownText;
  const hasValue = costBasisText.trim().length > 0;
  const showGain = gainPerUnit != null && gainLabel != null;

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.group}>
        <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
          {gradeTitle}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${gradeTitle}: ${gradeLabel ?? 'Select'}`}
          onPress={onOpenGradePicker}
          style={({ pressed }) => [
            styles.selector,
            { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.9 : 1 },
          ]}
          testID={`${testID}-grade-trigger`}
        >
          <Text style={[theme.typography.label, { color: theme.colors.gray900 }]}>
            {gradeLabel ?? 'Select'}
          </Text>
          <NavArrowDown color={theme.colors.gray400} height={24} width={24} />
        </Pressable>
      </View>

      <View style={styles.group}>
        <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
          Quantity
        </Text>
        <View style={styles.stepper}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Decrease quantity"
            accessibilityState={{ disabled: quantity <= 1 }}
            disabled={quantity <= 1}
            onPress={onDecrement}
            style={({ pressed }) => [
              styles.stepperButton,
              { backgroundColor: theme.colors.gray50, opacity: pressed || quantity <= 1 ? 0.5 : 1 },
            ]}
            testID={`${testID}-quantity-decrement`}
          >
            <Minus color={theme.colors.gray900} height={20} width={20} />
          </Pressable>
          <Text
            style={[styles.quantityValue, theme.typography.titleMedium]}
            testID={`${testID}-quantity-value`}
          >
            {quantity}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Increase quantity"
            onPress={onIncrement}
            style={({ pressed }) => [
              styles.stepperButton,
              { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.5 : 1 },
            ]}
            testID={`${testID}-quantity-increment`}
          >
            <Plus color={theme.colors.gray900} height={20} width={20} />
          </Pressable>
        </View>
      </View>

      <View style={styles.group}>
        <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
          Cost Basis
        </Text>
        <View style={[styles.costBasisRow, { borderBottomColor: theme.colors.gray200 }]}>
          <View style={styles.costBasisLeft}>
            <View style={styles.costBasisInputWrap}>
              {hasValue ? (
                <Text
                  style={[
                    theme.typography.bodyMedium,
                    { color: theme.colors.gray900, lineHeight: undefined },
                  ]}
                >
                  $
                </Text>
              ) : null}
              <TextInput
                keyboardType="decimal-pad"
                onChangeText={onChangeCostBasisText}
                placeholder="$0.00 (or value if traded or gifted)"
                placeholderTextColor={theme.colors.gray400}
                style={[
                  theme.typography.bodyMedium,
                  styles.costBasisInput,
                  { color: theme.colors.gray900, lineHeight: undefined },
                  showGain ? null : styles.costBasisInputGrow,
                ]}
                testID={`${testID}-cost-basis-input`}
                value={costBasisText}
              />
            </View>
            {showGain ? (
              <View style={[styles.gainPill, { backgroundColor: gainSurface }]}>
                {gainPositive ? (
                  <ArrowUp color={gainColor} height={16} width={16} strokeWidth={2} />
                ) : (
                  <ArrowDown color={gainColor} height={16} width={16} strokeWidth={2} />
                )}
                <Text style={[theme.typography.label, { color: gainColor }]}>{gainLabel}</Text>
              </View>
            ) : null}
          </View>
          {updatedLabel ? (
            <Text style={[theme.typography.overline, styles.updated, { color: theme.colors.gray600 }]}>
              {updatedLabel}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  costBasisInput: {
    padding: 0,
  },
  costBasisInputGrow: {
    flex: 1,
  },
  costBasisInputWrap: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 2,
  },
  costBasisLeft: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 8,
  },
  costBasisRow: {
    alignItems: 'flex-end',
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 32,
    paddingVertical: 6,
  },
  gainPill: {
    alignItems: 'center',
    borderRadius: 4,
    flexDirection: 'row',
    gap: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  group: {
    gap: 10,
    width: '100%',
  },
  quantityValue: {
    minWidth: 24,
    textAlign: 'center',
  },
  root: {
    gap: 16,
    width: '100%',
  },
  selector: {
    alignItems: 'center',
    borderRadius: 8,
    flexDirection: 'row',
    height: 32,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    width: 160,
  },
  stepper: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: 24,
  },
  stepperButton: {
    alignItems: 'center',
    borderRadius: 999,
    justifyContent: 'center',
    padding: 6,
  },
  updated: {
    flexShrink: 0,
    fontStyle: 'italic',
  },
});

export default OwnedEntryEditFields;

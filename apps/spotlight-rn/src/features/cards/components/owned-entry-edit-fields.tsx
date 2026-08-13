import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { ArrowDown, ArrowUp, Minus, NavArrowDown, Plus } from 'iconoir-react-native';

import { Text, useSpotlightTheme } from '@spotlight/design-system';

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
  /** Fired when the Cost Basis input gains/loses focus (lets the screen scroll
   *  the row above the keyboard). */
  onCostBasisFocus?: () => void;
  onCostBasisBlur?: () => void;
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
  onCostBasisFocus,
  onCostBasisBlur,
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
              {/*
                ALWAYS MOUNTED, shown and hidden with OPACITY only. On Android,
                adding or removing a SIBLING of a focused TextInput steals its
                focus — mounting this "$" on the first keystroke (and dropping
                it on backspace-to-empty) is what "the numbers go away / the
                cursor vanished" was. Opacity changes no layout and steals no
                focus; the reserved sliver of width when hidden is the price.
              */}
              <Text
                style={[
                  theme.typography.bodyMedium,
                  { color: theme.colors.gray900, lineHeight: undefined, opacity: hasValue ? 1 : 0 },
                ]}
              >
                $
              </Text>
              <TextInput
                keyboardType="decimal-pad"
                onBlur={onCostBasisBlur}
                onChangeText={onChangeCostBasisText}
                onFocus={onCostBasisFocus}
                placeholder="$0.00 (or value if traded or gifted)"
                placeholderTextColor={theme.colors.gray400}
                style={[
                  theme.typography.bodyMedium,
                  styles.costBasisInput,
                  { color: theme.colors.gray900, lineHeight: undefined },
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
    /*
      ALWAYS flexed, never conditionally. The flex used to be dropped the
      moment `showGain` flipped true — i.e. the first keystroke that made the
      typed value parseable — and an unflexed TextInput being squeezed by the
      newly-mounted gain pill collapses to nothing on Android (iOS holds its
      intrinsic content width): reported as "typing into the cost basis makes
      the text disappear". `minWidth` is the floor the pill can never squeeze
      it below; the pill itself refuses to shrink instead (`gainPill`).
    */
    flexGrow: 1,
    flexShrink: 1,
    /*
      EXPLICIT HEIGHT, because the style strips `lineHeight` (a TextInput
      renders it badly) and Android's intrinsic TextInput measurement collapses
      to ZERO HEIGHT after the first controlled-text update — measured live on
      device: frame 76,2867-519,2867. A zero-tall input clips its own text and
      cursor invisible and leaves a hairline tap target, which was the whole
      "numbers vanish / cursor gone / have to tap the exact spot" family.
      28 covers bodyMedium at the 1.2 Dynamic Type cap. The design-system
      TextField does the same strip-plus-fixed-height; this input must too.
    */
    minHeight: 28,
    minWidth: 88,
    padding: 0,
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
    // The pill keeps its size; the input yields (down to its minWidth).
    flexShrink: 0,
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

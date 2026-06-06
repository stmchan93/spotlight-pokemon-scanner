import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSpotlightTheme, type SpotlightTheme } from '@spotlight/design-system';
import type { MarketHistoryOption } from '@spotlight/api-client';
import { Minus, NavArrowDown, NavArrowUp, Plus } from 'iconoir-react-native';

type GradeOption = {
  id: string;
  label: string;
};

type CardConfiguratorProps = {
  variants: MarketHistoryOption[];
  selectedVariant: string | null;
  onSelectVariant: (id: string) => void;
  graders: string[];
  selectedGrader: string | null;
  onSelectGrader: (grader: string) => void;
  gradeLabel: string | null;
  gradeTitle: string;
  gradeOptions: GradeOption[];
  gradeSelectedId: string | null;
  onSelectGrade: (id: string) => void;
  quantity: number;
  onDecrement: () => void;
  onIncrement: () => void;
  testID?: string;
};

/**
 * Solid-dark-when-selected option chip matching the Figma card-detail design:
 * selected = gray900 fill + white label, unselected = gray50 fill + dark
 * label. PillButton's tones don't express the dark-selected state, so this
 * local chip drives the variant / grader rows while still using shared tokens
 * and the 13/medium `label` typography role (color overridden).
 */
function OptionChip({
  label,
  selected,
  onPress,
  theme,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  theme: SpotlightTheme;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          borderRadius: theme.radii.sm,
          backgroundColor: selected ? theme.colors.gray900 : theme.colors.gray50,
          borderColor: selected ? theme.colors.gray900 : theme.colors.gray50,
          opacity: pressed ? 0.88 : 1,
        },
      ]}
      testID={testID}
    >
      <Text
        style={[
          theme.typography.label,
          { color: selected ? theme.colors.gray0 : theme.colors.gray900 },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function GroupTitle({ children, theme }: { children: string; theme: SpotlightTheme }) {
  return (
    <Text style={[theme.typography.titleSmall, { color: theme.colors.gray900 }]}>
      {children}
    </Text>
  );
}

export function CardConfigurator({
  variants,
  selectedVariant,
  onSelectVariant,
  graders,
  selectedGrader,
  onSelectGrader,
  gradeLabel,
  gradeTitle,
  gradeOptions,
  gradeSelectedId,
  onSelectGrade,
  quantity,
  onDecrement,
  onIncrement,
  testID,
}: CardConfiguratorProps) {
  const theme = useSpotlightTheme();
  const [gradeOpen, setGradeOpen] = useState(false);

  return (
    <View style={[styles.root, { gap: 16 }]} testID={testID}>
      {variants.length > 0 ? (
        <View style={[styles.group, { gap: 10 }]}>
          <GroupTitle theme={theme}>Variant</GroupTitle>
          <View style={[styles.chipRow, { gap: 6 }]}>
            {variants.map((variant) => (
              <OptionChip
                key={variant.id}
                label={variant.label}
                onPress={() => onSelectVariant(variant.id)}
                selected={variant.id === selectedVariant}
                testID={testID ? `${testID}-variant-${variant.id}` : undefined}
                theme={theme}
              />
            ))}
          </View>
        </View>
      ) : null}

      <View style={[styles.group, { gap: 10 }]}>
        <GroupTitle theme={theme}>Grader</GroupTitle>
        <View style={[styles.chipRow, { gap: 10 }]}>
          {graders.map((grader) => (
            <OptionChip
              key={grader}
              label={grader}
              onPress={() => onSelectGrader(grader)}
              selected={grader === selectedGrader}
              testID={testID ? `${testID}-grader-${grader}` : undefined}
              theme={theme}
            />
          ))}
        </View>
      </View>

      <View style={[styles.group, { gap: 10 }]}>
        <GroupTitle theme={theme}>{gradeTitle}</GroupTitle>
        <View
          style={[
            styles.gradePanel,
            { backgroundColor: theme.colors.gray50, borderRadius: theme.radii.sm },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${gradeTitle}: ${gradeLabel ?? 'Select'}`}
            accessibilityState={{ expanded: gradeOpen }}
            onPress={() => setGradeOpen((open) => !open)}
            style={({ pressed }) => [styles.gradeHeader, { opacity: pressed ? 0.9 : 1 }]}
            testID={testID ? `${testID}-grade-trigger` : undefined}
          >
            <Text style={[theme.typography.label, { color: theme.colors.gray700 }]}>
              {gradeLabel ?? 'Select'}
            </Text>
            {gradeOpen ? (
              <NavArrowUp color={theme.colors.gray700} height={24} width={24} />
            ) : (
              <NavArrowDown color={theme.colors.gray700} height={24} width={24} />
            )}
          </Pressable>
          {gradeOpen
            ? gradeOptions.map((option) => (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: option.id === gradeSelectedId }}
                  onPress={() => {
                    onSelectGrade(option.id);
                    setGradeOpen(false);
                  }}
                  style={({ pressed }) => [
                    styles.gradeOption,
                    {
                      backgroundColor:
                        option.id === gradeSelectedId ? theme.colors.gray200 : 'transparent',
                      opacity: pressed ? 0.84 : 1,
                    },
                  ]}
                  testID={testID ? `${testID}-grade-option-${option.id}` : undefined}
                >
                  <Text style={[theme.typography.label, { color: theme.colors.gray900 }]}>
                    {option.label}
                  </Text>
                </Pressable>
              ))
            : null}
        </View>
      </View>

      <View style={[styles.group, { gap: 10 }]}>
        <GroupTitle theme={theme}>Quantity</GroupTitle>
        <View style={styles.stepper}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Decrease quantity"
            accessibilityState={{ disabled: quantity <= 0 }}
            disabled={quantity <= 0}
            onPress={onDecrement}
            style={({ pressed }) => [
              styles.stepperButton,
              {
                backgroundColor: theme.colors.gray50,
                opacity: pressed || quantity <= 0 ? 0.5 : 1,
              },
            ]}
            testID={testID ? `${testID}-quantity-decrement` : undefined}
          >
            <Minus color={theme.colors.gray900} height={20} width={20} />
          </Pressable>
          <Text
            style={[styles.quantityValue, theme.typography.titleMedium]}
            testID={testID ? `${testID}-quantity-value` : undefined}
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
            testID={testID ? `${testID}-quantity-increment` : undefined}
          >
            <Plus color={theme.colors.gray900} height={20} width={20} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  chipRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gradeHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  gradeOption: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  gradePanel: {
    alignSelf: 'flex-start',
    overflow: 'hidden',
    width: 160,
  },
  group: {
    width: '100%',
  },
  quantityValue: {
    minWidth: 24,
    textAlign: 'center',
  },
  root: {
    width: '100%',
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
});

export default CardConfigurator;

import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  IconButton,
  useSpotlightTheme,
  type SpotlightTheme,
} from '@spotlight/design-system';
import type { MarketHistoryOption } from '@spotlight/api-client';
import { Minus, NavArrowDown, Plus } from 'iconoir-react-native';

type CardConfiguratorProps = {
  variants: MarketHistoryOption[];
  selectedVariant: string | null;
  onSelectVariant: (id: string) => void;
  graders: string[];
  selectedGrader: string | null;
  onSelectGrader: (grader: string) => void;
  gradeLabel: string | null;
  gradeTitle: string;
  onPressGrade: () => void;
  quantity: number;
  onDecrement: () => void;
  onIncrement: () => void;
  testID?: string;
};

/**
 * Solid-dark-when-selected option chip matching the Figma card-detail design:
 * selected = gray900 fill + white label, unselected = light field fill + dark
 * label. PillButton's tones don't express the dark-selected state, so this
 * local chip drives the variant / grader rows while still using shared tokens
 * and the `control` typography role.
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
          backgroundColor: selected ? theme.colors.gray900 : theme.colors.field,
          borderColor: selected ? theme.colors.gray900 : theme.colors.outlineSubtle,
          opacity: pressed ? 0.88 : 1,
        },
      ]}
      testID={testID}
    >
      <Text
        style={[
          theme.typography.control,
          { color: selected ? theme.colors.gray0 : theme.colors.textPrimary },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function GroupTitle({ children, theme }: { children: string; theme: SpotlightTheme }) {
  return (
    <Text style={[theme.typography.captionMedium, { color: theme.colors.gray600 }]}>
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
  onPressGrade,
  quantity,
  onDecrement,
  onIncrement,
  testID,
}: CardConfiguratorProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={[styles.root, { gap: theme.spacing.md }]} testID={testID}>
      {variants.length > 0 ? (
        <View style={[styles.group, { gap: theme.spacing.xs }]}>
          <GroupTitle theme={theme}>Variant</GroupTitle>
          <View style={[styles.chipRow, { gap: theme.spacing.xxs }]}>
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

      <View style={[styles.group, { gap: theme.spacing.xs }]}>
        <GroupTitle theme={theme}>Grader</GroupTitle>
        <View style={[styles.chipRow, { gap: theme.spacing.xxs }]}>
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

      <View style={[styles.group, { gap: theme.spacing.xs }]}>
        <GroupTitle theme={theme}>{gradeTitle}</GroupTitle>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${gradeTitle}: ${gradeLabel ?? 'Select'}`}
          onPress={onPressGrade}
          style={({ pressed }) => [
            styles.dropdown,
            {
              backgroundColor: theme.colors.field,
              borderColor: theme.colors.outlineSubtle,
              borderRadius: theme.radii.md,
              opacity: pressed ? 0.9 : 1,
            },
          ]}
          testID={testID ? `${testID}-grade-trigger` : undefined}
        >
          <Text
            style={[
              theme.typography.control,
              { color: gradeLabel ? theme.colors.textPrimary : theme.colors.gray500 },
            ]}
          >
            {gradeLabel ?? 'Select'}
          </Text>
          <NavArrowDown color={theme.colors.gray600} height={18} width={18} />
        </Pressable>
      </View>

      <View style={[styles.group, { gap: theme.spacing.xs }]}>
        <GroupTitle theme={theme}>Quantity</GroupTitle>
        <View
          style={[
            styles.stepper,
            {
              backgroundColor: theme.colors.field,
              borderColor: theme.colors.outlineSubtle,
              borderRadius: theme.radii.pill,
              gap: theme.spacing.sm,
            },
          ]}
        >
          <IconButton
            accessibilityLabel="Decrease quantity"
            disabled={quantity <= 0}
            onPress={onDecrement}
            size={32}
            testID={testID ? `${testID}-quantity-decrement` : undefined}
            variant="ghost"
          >
            <Minus color={theme.colors.gray900} height={16} width={16} />
          </IconButton>
          <Text
            style={[styles.quantityValue, theme.typography.bodyStrong]}
            testID={testID ? `${testID}-quantity-value` : undefined}
          >
            {quantity}
          </Text>
          <IconButton
            accessibilityLabel="Increase quantity"
            onPress={onIncrement}
            size={32}
            testID={testID ? `${testID}-quantity-increment` : undefined}
            variant="ghost"
          >
            <Plus color={theme.colors.gray900} height={16} width={16} />
          </IconButton>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 36,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  chipRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  dropdown: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    minHeight: 44,
    minWidth: 160,
    paddingHorizontal: 16,
    paddingVertical: 10,
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
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 44,
    paddingHorizontal: 8,
  },
});

export default CardConfigurator;

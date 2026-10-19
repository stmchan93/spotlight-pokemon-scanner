import { Pressable, StyleSheet, View } from 'react-native';

import { SkeletonBlock, Text, useSpotlightTheme, type SpotlightTheme } from '@spotlight/design-system';
import type { MarketHistoryOption } from '@spotlight/api-client';

type CardConfiguratorProps = {
  /** Language options (e.g. "EN", "JP") rendered as the first chip row. */
  languages: string[];
  selectedLanguage: string;
  onSelectLanguage: (language: string) => void;
  variants: MarketHistoryOption[];
  /**
   * True while detail/variant data is still loading. When set and no variants
   * have resolved yet, the Variant row renders a skeleton instead of collapsing.
   */
  variantsLoading?: boolean;
  selectedVariant: string | null;
  onSelectVariant: (id: string) => void;
  graders: string[];
  selectedGrader: string | null;
  onSelectGrader: (grader: string) => void;
  testID?: string;
};

/**
 * Solid-dark-when-selected option chip matching the Figma PDP (5768:21988
 * "Option Item"): selected = gray900 fill + white label, unselected = gray50
 * fill + dark label; the label is Caption (Regular 13) drawn UPPERCASE in both
 * states — selection changes color only, not weight. PillButton's tones don't
 * express the dark-selected state, so this local chip drives the rows.
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
          borderCurve: 'continuous',
          borderRadius: theme.radii.sm,
          backgroundColor: selected ? theme.colors.gray900 : theme.colors.gray50,
          borderColor: selected ? theme.colors.gray900 : theme.colors.gray50,
          opacity: pressed ? 0.88 : 1,
        },
      ]}
      testID={testID}
    >
      {/* One line: Android drew "Third Anniversary" wider than it measured,
          wrapping "Anniversary" onto a second line the chip never showed. */}
      <Text
        numberOfLines={1}
        style={[
          theme.typography.caption,
          { color: selected ? theme.colors.gray0 : theme.colors.gray900 },
        ]}
      >
        {/* Capitals on the string: iOS measures the one-line chip from the
            untransformed label and clips a `textTransform`. */}
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

// Option-group header per Figma 5768:21988 "Option Container": Label (Medium
// 14) gray900, UPPERCASE ("LANGUAGE" / "VARIANT" / "GRADER"). The sentence-case
// Title-small frames (5768:22713 / 5768:23886) are NOT the reference.
function GroupTitle({ children, theme }: { children: string; theme: SpotlightTheme }) {
  return (
    <Text style={[theme.typography.label, { color: theme.colors.gray900 }]}>
      {children.toUpperCase()}
    </Text>
  );
}

export function CardConfigurator({
  languages,
  selectedLanguage,
  onSelectLanguage,
  variants,
  variantsLoading = false,
  selectedVariant,
  onSelectVariant,
  graders,
  selectedGrader,
  onSelectGrader,
  testID,
}: CardConfiguratorProps) {
  const theme = useSpotlightTheme();

  return (
    // 24 between option groups, 8 title→chips, per Figma 4211:86063
    // "Product Options" (was 16/10 from an older frame).
    <View style={[styles.root, { gap: 24 }]} testID={testID}>
      {/* Language row only renders when there's an actual other-language
          counterpart to switch to (driven by `languages`); hidden otherwise. */}
      {languages.length > 0 ? (
        <View style={[styles.group, { gap: 8 }]}>
          <GroupTitle theme={theme}>Language</GroupTitle>
          <View style={[styles.chipRow, { gap: 10 }]}>
            {languages.map((language) => (
              <OptionChip
                key={language}
                label={language}
                onPress={() => onSelectLanguage(language)}
                selected={language === selectedLanguage}
                testID={testID ? `${testID}-language-${language}` : undefined}
                theme={theme}
              />
            ))}
          </View>
        </View>
      ) : null}

      {variants.length > 0 ? (
        <View style={[styles.group, { gap: 8 }]}>
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
      ) : variantsLoading ? (
        <View style={[styles.group, { gap: 8 }]} testID={testID ? `${testID}-variant-skeleton` : undefined}>
          <GroupTitle theme={theme}>Variant</GroupTitle>
          <View style={[styles.chipRow, { gap: 6 }]}>
            <SkeletonBlock height={32} radius={theme.radii.sm} width={84} />
            <SkeletonBlock height={32} radius={theme.radii.sm} width={72} />
          </View>
        </View>
      ) : null}

      <View style={[styles.group, { gap: 8 }]}>
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
  group: {
    width: '100%',
  },
  root: {
    width: '100%',
  },
});

export default CardConfigurator;

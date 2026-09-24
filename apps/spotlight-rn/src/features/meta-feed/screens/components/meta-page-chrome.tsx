import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { NavArrowLeft } from 'iconoir-react-native';

import {
  GlassNavBubble,
  Text,
  glassNavBubbleGlyphSize,
  glassNavBubbleGlyphStrokeWidth,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

type MetaPageHeaderProps = {
  onBack: () => void;
  rightAccessory?: ReactNode;
  subtitle?: string | null;
  testID: string;
  title?: string | null;
};

/**
 * Top bar shared by the Meta, Set and News pages (mockups Meta/Set/News.dc):
 * a 44pt glass back bubble, an optional title + subtitle beside it, and an
 * optional right bubble (Set's share).
 */
export function MetaPageHeader({ onBack, rightAccessory, subtitle, testID, title }: MetaPageHeaderProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.header} testID={testID}>
      <GlassNavBubble accessibilityLabel="Go back" onPress={onBack} size="medium" testID={`${testID}-back`}>
        <NavArrowLeft
          color={theme.colors.gray900}
          height={glassNavBubbleGlyphSize}
          strokeWidth={glassNavBubbleGlyphStrokeWidth}
          width={glassNavBubbleGlyphSize}
        />
      </GlassNavBubble>
      <View style={styles.copy}>
        {title ? (
          <Text accessibilityRole="header" numberOfLines={1} style={theme.typography.titleLarge} testID={`${testID}-title`}>
            {title}
          </Text>
        ) : null}
        {subtitle ? (
          <Text numberOfLines={2} style={theme.typography.captionMedium}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {rightAccessory}
    </View>
  );
}

type MetaSectionProps = {
  children: ReactNode;
  /** Right-hand caption on the title row ("past 7 days"). */
  caption?: string | null;
  /** Replaces the caption with a control, e.g. the Groups sort toggle. */
  accessory?: ReactNode;
  /** Line under the title row. */
  description?: string | null;
  /** Draw the 4pt gray band that closes a section (not on the last one). */
  showBand?: boolean;
  testID?: string;
  title?: string | null;
};

/** A padded page section with a `titleXsmall` row, closed by the feed's 4pt band. */
export function MetaSection({ accessory, caption, children, description, showBand = true, testID, title }: MetaSectionProps) {
  const theme = useSpotlightTheme();

  return (
    <View
      style={[
        styles.section,
        showBand ? { borderBottomColor: theme.colors.gray100, borderBottomWidth: spacing.xxxs } : null,
      ]}
      testID={testID}
    >
      {title ? (
        <View style={styles.titleRow}>
          <Text accessibilityRole="header" style={[theme.typography.titleXsmall, styles.titleText]}>
            {title}
          </Text>
          {accessory ?? (caption ? <Text style={theme.typography.captionMedium}>{caption}</Text> : null)}
        </View>
      ) : null}
      {description ? (
        <Text style={[theme.typography.captionMedium, styles.description]}>{description}</Text>
      ) : null}
      {children}
    </View>
  );
}

/** Text color for a signed value ("+$412k" in green). */
export function useSignedColor(value: number | null | undefined): string {
  const theme = useSpotlightTheme();
  if (value == null || value === 0) {
    return theme.colors.gray700;
  }
  return value > 0 ? theme.colors.deltaUpText : theme.colors.deltaDownText;
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    minWidth: 0,
  },
  description: {
    marginTop: 2,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingBottom: spacing.xxs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
  },
  section: {
    padding: spacing.sm,
  },
  titleRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: spacing.xxs,
    justifyContent: 'space-between',
  },
  titleText: {
    flexShrink: 1,
  },
});

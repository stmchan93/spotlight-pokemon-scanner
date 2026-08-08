import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { PillButton } from './pill-button';
import { Text } from './scaled-text';
import { useSpotlightTheme } from '../theme';
import { spacing } from '../tokens';

type EmptyStatePromptProps = {
  /**
   * Optional leading glyph for the action chip (e.g. the nav scan icon). The
   * caller owns the icon so the design system stays free of app-specific art.
   */
  actionIcon?: ReactNode;
  /** Chip label. The chip only renders when both label and onActionPress are set. */
  actionLabel?: string;
  actionTestID?: string;
  /**
   * Optional art above the message — a brand mark, illustration, or icon.
   * Caller-owned for the same reason as `actionIcon`.
   */
  illustration?: ReactNode;
  /** One short encouraging line. Centered. */
  message: string;
  onActionPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Chromeless "nothing here yet, here's the way in" prompt: centered art, one
 * line of copy, and a low-emphasis action chip (Figma Collection empty state
 * 3370:4175, "Logo Container").
 *
 * Use this — not `StateCard` — when the state is an *invitation* rather than an
 * outcome. `StateCard` is a bordered surface built around a title + supporting
 * message + solid Button; it reads as a reported result (error, unavailable,
 * "no matches"). This reads as onboarding: no card, no title, no heavy button.
 */
export function EmptyStatePrompt({
  actionIcon,
  actionLabel,
  actionTestID,
  illustration,
  message,
  onActionPress,
  style,
  testID,
}: EmptyStatePromptProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={[styles.root, style]} testID={testID}>
      {illustration}
      <Text style={[theme.typography.bodyMedium, styles.message]}>{message}</Text>
      {actionLabel && onActionPress ? (
        <PillButton
          label={actionLabel}
          leading={actionIcon}
          onPress={onActionPress}
          testID={actionTestID}
          tone="soft"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  message: {
    textAlign: 'center',
  },
  root: {
    alignItems: 'center',
    gap: spacing.xs,
  },
});

import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing, textStyles } from '@spotlight/design-system';

const DEFAULT_AUTO_DISMISS_MS = 10000;

export type RecentCaptureWarningChipProps = {
  message: string;
  primaryActionLabel: string;
  onPrimaryAction: () => void;
  secondaryActionLabel: string;
  onSecondaryAction: () => void;
  /**
   * Auto-dismiss delay in ms. Defaults to 10000. Pass `null` to disable the
   * timer entirely (no auto-dismiss scheduled).
   */
  autoDismissMs?: number | null;
  onAutoDismiss?: () => void;
  testID?: string;
};

/**
 * Screen-local, prop-driven warning chip rendered above a recent capture row.
 * Matches the design-system `Toast` `tone="warning"` look (yellow brand
 * background) without coupling to its `visible`/animation lifecycle. Tapping
 * either action cancels the auto-dismiss timer first, then fires the handler.
 *
 * Promotable to `packages/design-system` later if other surfaces need it.
 */
export function RecentCaptureWarningChip({
  message,
  primaryActionLabel,
  onPrimaryAction,
  secondaryActionLabel,
  onSecondaryAction,
  autoDismissMs = DEFAULT_AUTO_DISMISS_MS,
  onAutoDismiss,
  testID,
}: RecentCaptureWarningChipProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hold the latest auto-dismiss callback so the timer effect doesn't reset
  // every time the parent re-renders with a new closure.
  const onAutoDismissRef = useRef(onAutoDismiss);
  useEffect(() => {
    onAutoDismissRef.current = onAutoDismiss;
  }, [onAutoDismiss]);

  useEffect(() => {
    if (autoDismissMs === null || autoDismissMs === undefined) {
      return undefined;
    }
    const timer = setTimeout(() => {
      timerRef.current = null;
      onAutoDismissRef.current?.();
    }, autoDismissMs);
    timerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (timerRef.current === timer) {
        timerRef.current = null;
      }
    };
  }, [autoDismissMs]);

  const clearAutoDismissTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handlePrimaryPress = () => {
    clearAutoDismissTimer();
    onPrimaryAction();
  };

  const handleSecondaryPress = () => {
    clearAutoDismissTimer();
    onSecondaryAction();
  };

  return (
    <View style={styles.container} testID={testID}>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={primaryActionLabel}
          hitSlop={8}
          onPress={handlePrimaryPress}
          style={styles.actionButton}
          testID={testID ? `${testID}-primary` : undefined}
        >
          <Text style={styles.actionLabelPrimary}>{primaryActionLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={secondaryActionLabel}
          hitSlop={8}
          onPress={handleSecondaryPress}
          style={styles.actionButton}
          testID={testID ? `${testID}-secondary` : undefined}
        >
          <Text style={styles.actionLabelSecondary}>{secondaryActionLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.brand,
    borderRadius: radii.md,
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    gap: spacing.xxs,
  },
  message: {
    ...textStyles.body,
    color: colors.textPrimary,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  actionButton: {
    flex: 1,
    paddingVertical: spacing.xxxs,
  },
  actionLabelPrimary: {
    ...textStyles.control,
    color: colors.textPrimary,
  },
  actionLabelSecondary: {
    ...textStyles.control,
    color: colors.textSecondary,
  },
});

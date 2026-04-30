import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
export type BadgeSize = 'sm' | 'md';

type BadgeProps = {
  label: string;
  size?: BadgeSize;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  tone?: BadgeTone;
};

export function Badge({
  label,
  size = 'md',
  style,
  testID,
  tone = 'neutral',
}: BadgeProps) {
  const theme = useSpotlightTheme();

  const toneStyle =
    tone === 'brand'
      ? { backgroundColor: theme.colors.brand, borderColor: theme.colors.brand, color: theme.colors.textPrimary }
      : tone === 'success'
        ? { backgroundColor: theme.colors.success, borderColor: theme.colors.success, color: theme.colors.canvasElevated }
        : tone === 'warning'
          ? { backgroundColor: theme.colors.warning, borderColor: theme.colors.warning, color: theme.colors.textPrimary }
          : tone === 'danger'
            ? { backgroundColor: theme.colors.danger, borderColor: theme.colors.danger, color: theme.colors.canvasElevated }
            : tone === 'info'
              ? { backgroundColor: theme.colors.surfaceMuted, borderColor: theme.colors.info, color: theme.colors.textPrimary }
              : { backgroundColor: theme.colors.field, borderColor: theme.colors.outlineSubtle, color: theme.colors.textSecondary };

  return (
    <View
      style={[
        styles.badge,
        size === 'sm' ? styles.badgeSmall : styles.badgeMedium,
        {
          backgroundColor: toneStyle.backgroundColor,
          borderColor: toneStyle.borderColor,
          borderRadius: theme.radii.pill,
        },
        style,
      ]}
      testID={testID}
    >
      <AppText style={[styles.label, { color: toneStyle.color }]} variant="micro">
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    justifyContent: 'center',
  },
  badgeMedium: {
    minHeight: 26,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeSmall: {
    minHeight: 22,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  label: {
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});

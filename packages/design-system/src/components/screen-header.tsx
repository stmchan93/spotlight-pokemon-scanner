import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';

type ScreenHeaderProps = {
  eyebrow?: string;
  leftAccessory?: ReactNode;
  rightAccessory?: ReactNode;
  style?: StyleProp<ViewStyle>;
  subtitle?: string;
  title: string;
};

export function ScreenHeader({
  eyebrow,
  leftAccessory,
  rightAccessory,
  style,
  subtitle,
  title,
}: ScreenHeaderProps) {
  const theme = useSpotlightTheme();

  return (
    <View style={[styles.header, style]}>
      <View style={styles.topRow}>
        <View style={styles.accessorySlot}>
          {leftAccessory}
        </View>
        <View style={styles.copy}>
          {eyebrow ? (
            <Text style={[theme.typography.micro, styles.eyebrow]}>{eyebrow}</Text>
          ) : null}
          <Text style={theme.typography.display}>{title}</Text>
          {subtitle ? (
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={[styles.accessorySlot, styles.accessorySlotRight]}>
          {rightAccessory}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  accessorySlot: {
    minWidth: 40,
  },
  accessorySlotRight: {
    alignItems: 'flex-end',
  },
  copy: {
    flex: 1,
    gap: 8,
    minWidth: 0,
  },
  eyebrow: {
    letterSpacing: 1.4,
  },
  header: {
    gap: 12,
  },
  topRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
});

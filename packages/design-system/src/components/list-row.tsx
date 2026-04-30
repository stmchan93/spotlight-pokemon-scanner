import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

type ListRowProps = {
  leading?: ReactNode;
  meta?: string;
  onPress?: () => void;
  rightAccessory?: ReactNode;
  style?: StyleProp<ViewStyle>;
  subtitle?: string;
  testID?: string;
  title: string;
};

export function ListRow({
  leading,
  meta,
  onPress,
  rightAccessory,
  style,
  subtitle,
  testID,
  title,
}: ListRowProps) {
  const theme = useSpotlightTheme();
  const Container = onPress ? Pressable : View;
  const containerProps = onPress
    ? {
        accessibilityRole: 'button' as const,
        onPress,
        style: ({ pressed }: { pressed: boolean }) => [
          styles.row,
          {
            backgroundColor: theme.colors.canvasElevated,
            borderColor: theme.colors.outlineSubtle,
            borderRadius: theme.radii.lg,
            opacity: pressed ? 0.82 : 1,
          },
          style,
        ],
        testID,
      }
    : {
        style: [
          styles.row,
          {
            backgroundColor: theme.colors.canvasElevated,
            borderColor: theme.colors.outlineSubtle,
            borderRadius: theme.radii.lg,
          },
          style,
        ],
        testID,
      };

  return (
    <Container {...containerProps}>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <AppText numberOfLines={1} style={styles.title} variant="bodyStrong">
            {title}
          </AppText>
          {meta ? (
            <AppText color="textSecondary" numberOfLines={1} variant="caption">
              {meta}
            </AppText>
          ) : null}
        </View>
        {subtitle ? (
          <AppText color="textSecondary" numberOfLines={2} variant="body">
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {rightAccessory ? <View style={styles.rightAccessory}>{rightAccessory}</View> : null}
    </Container>
  );
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  leading: {
    justifyContent: 'center',
  },
  rightAccessory: {
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  row: {
    alignItems: 'center',
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  title: {
    flex: 1,
  },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
});

import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { Button, type ButtonVariant } from './button';
import { SurfaceCard } from './surface-card';

type StateCardProps = {
  actionLabel?: string;
  actionTestID?: string;
  actionVariant?: ButtonVariant;
  centered?: boolean;
  loading?: boolean;
  message: string;
  onActionPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title: string;
  variant?: 'elevated' | 'muted' | 'field';
};

export function StateCard({
  actionLabel,
  actionTestID,
  actionVariant = 'primary',
  centered = false,
  loading = false,
  message,
  onActionPress,
  style,
  testID,
  title,
  variant = 'elevated',
}: StateCardProps) {
  const theme = useSpotlightTheme();

  return (
    <SurfaceCard padding={16} radius={16} style={style} testID={testID} variant={variant}>
      <View style={[styles.content, centered ? styles.contentCentered : null]}>
        {loading ? <ActivityIndicator color={theme.colors.brand} /> : null}
        <View style={[styles.copy, centered ? styles.copyCentered : null]}>
          <Text style={[theme.typography.headline, centered ? styles.textCentered : null]}>{title}</Text>
          <Text
            style={[
              theme.typography.body,
              centered ? styles.textCentered : null,
              { color: theme.colors.textSecondary },
            ]}
          >
            {message}
          </Text>
        </View>
        {actionLabel && onActionPress ? (
          <Button
            label={actionLabel}
            onPress={onActionPress}
            style={centered ? styles.actionCentered : null}
            testID={actionTestID}
            variant={actionVariant}
          />
        ) : null}
      </View>
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  actionCentered: {
    alignSelf: 'center',
  },
  content: {
    gap: 14,
  },
  contentCentered: {
    alignItems: 'center',
  },
  copy: {
    gap: 10,
  },
  copyCentered: {
    alignItems: 'center',
  },
  textCentered: {
    textAlign: 'center',
  },
});

import { Image, StyleSheet, View, type ImageSourcePropType, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { AppText } from './app-text';

type CardThumbnailProps = {
  accessibilityLabel?: string;
  source?: ImageSourcePropType | null;
  size?: 'sm' | 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const sizeMetrics = {
  sm: { width: 44, height: 60, radius: 8 },
  md: { width: 58, height: 78, radius: 10 },
  lg: { width: 74, height: 100, radius: 12 },
} as const;

export function CardThumbnail({
  accessibilityLabel = 'Card thumbnail',
  source,
  size = 'md',
  style,
  testID,
}: CardThumbnailProps) {
  const theme = useSpotlightTheme();
  const metrics = sizeMetrics[size];

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.frame,
        {
          width: metrics.width,
          height: metrics.height,
          borderRadius: metrics.radius,
          backgroundColor: theme.colors.field,
          borderColor: theme.colors.outlineSubtle,
        },
        style,
      ]}
      testID={testID}
    >
      {source ? (
        <Image
          resizeMode="cover"
          source={source}
          style={[StyleSheet.absoluteFill, { borderRadius: metrics.radius }]}
        />
      ) : (
        <AppText color="textSecondary" style={styles.placeholder} variant="micro">
          CARD
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    borderWidth: 1,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  placeholder: {
    letterSpacing: 0.8,
  },
});

import { Image as ExpoImage } from 'expo-image';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useSpotlightTheme } from '../theme';
import { Text } from './scaled-text';

type AvatarProps = {
  initials: string;
  ring?: boolean;
  ringColor?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  uri?: string | null;
};

export function Avatar({
  initials,
  ring = false,
  ringColor,
  size = 48,
  style,
  testID,
  uri,
}: AvatarProps) {
  const theme = useSpotlightTheme();

  const ringStyle = ring
    ? { borderColor: ringColor ?? theme.colors.canvasElevated, borderWidth: 3 }
    : null;

  const hasImage = typeof uri === 'string' && uri.length > 0;

  return (
    <View
      style={[
        styles.container,
        { borderRadius: size / 2, height: size, width: size },
        hasImage ? null : { backgroundColor: theme.colors.purple500 },
        ringStyle,
        style,
      ]}
      testID={testID}
    >
      {hasImage ? (
        <ExpoImage
          contentFit="cover"
          source={{ uri }}
          style={{ borderRadius: size / 2, height: size, width: size }}
          testID={testID ? `${testID}-image` : undefined}
        />
      ) : (
        <Text
          style={[styles.initials, { color: theme.colors.gray0, fontSize: size * 0.4 }]}
        >
          {initials}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initials: {
    fontWeight: '600',
  },
});

import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Calendar } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

type EventFlyerProps = {
  uri: string | null;
  width: number;
  height: number;
  radius: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * The show flyer, clipped by its wrapper (RN `Image` takes no `borderCurve`).
 * An event without a flyer gets a quiet calendar placeholder at the same size.
 */
export function EventFlyer({ uri, width, height, radius, style, testID }: EventFlyerProps) {
  const theme = useSpotlightTheme();
  return (
    <View
      style={[
        styles.frame,
        { width, height, borderRadius: radius, backgroundColor: theme.colors.gray100 },
        style,
      ]}
      testID={testID}
    >
      {uri ? (
        <Image accessibilityIgnoresInvertColors resizeMode="cover" source={{ uri }} style={styles.image} />
      ) : (
        <Calendar color={theme.colors.gray400} height={28} strokeWidth={1.5} width={28} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignItems: 'center',
    borderCurve: 'continuous',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: {
    height: '100%',
    width: '100%',
  },
});

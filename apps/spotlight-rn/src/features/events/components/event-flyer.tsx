import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Calendar } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';

type EventFlyerProps = {
  uri: string | null;
  width: number;
  height: number;
  radius: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * The show flyer, clipped by its wrapper (images take no `borderCurve`).
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
        // Disk-cached: RN's Image re-downloaded every flyer on each visit.
        <CachedImage
          accessibilityIgnoresInvertColors
          cachePolicy={imageCachePolicy.full}
          contentFit="cover"
          style={styles.image}
          transition={150}
          uri={uri}
        />
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

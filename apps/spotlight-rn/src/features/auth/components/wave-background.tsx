import { Image, StyleSheet, View } from 'react-native';

type WaveBackgroundProps = {
  /** Height of the wave band; it sits on pure black, matching the auth screen. */
  height: number;
  testID?: string;
};

/**
 * Static halftone-wave hero shown behind the top of every auth screen
 * (Figma 1565:4418). Previously an animated wave (WebView, then Reanimated) — now
 * a flat image, so the sign-in flow has NO animation. Non-interactive; taps pass
 * straight through.
 */
export function WaveBackground({ height, testID }: WaveBackgroundProps) {
  return (
    <View pointerEvents="none" style={[styles.root, { height }]} testID={testID}>
      <Image
        resizeMode="cover"
        source={require('../../../../assets/images/auth-wave-hero.png')}
        style={styles.image}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#000000',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  image: {
    height: '100%',
    width: '100%',
  },
});

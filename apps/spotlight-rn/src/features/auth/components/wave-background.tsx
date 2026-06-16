import { useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { WAVE_RUNTIME_HTML } from './wave-runtime-html';

type WaveBackgroundProps = {
  /** Height of the wave band; the wave fades to pure black at its top/bottom edges. */
  height: number;
  testID?: string;
};

/**
 * The flowing halftone-wave hero shown behind the top of every auth screen
 * (Figma 1481:4380). Renders the design handoff's exact wave-bg.js inside a
 * transparent-edged WebView so the animation is pixel-identical to the source:
 * two lighten-blended layers weaving on a sum-of-sines drift with an SVG
 * feTurbulence/feDisplacementMap water ripple, never repeating.
 *
 * The runtime HTML (CSS + JS + the halftone image as a data URI) is fully
 * self-contained, so there is no file-access configuration and dev/prod render
 * the same. The band is pure black where there are no dots, matching the black
 * auth background below it. Non-interactive — taps pass straight through.
 */
export function WaveBackground({ height, testID }: WaveBackgroundProps) {
  // Static source — memoized so the WebView never reloads on re-render.
  const source = useMemo(() => ({ html: WAVE_RUNTIME_HTML }), []);

  return (
    <View pointerEvents="none" style={[styles.root, { height }]} testID={testID}>
      <WebView
        androidLayerType="hardware"
        // The page itself is black; nothing behind it needs to show through.
        bounces={false}
        // Wave image is an inline data URI; allow it to load without origin checks.
        domStorageEnabled={false}
        injectedJavaScript=""
        originWhitelist={['*']}
        overScrollMode="never"
        pointerEvents="none"
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        source={source}
        style={styles.webview}
        // iOS: keep the canvas painting while the keyboard/app is busy.
        {...(Platform.OS === 'ios' ? { allowsInlineMediaPlayback: true } : null)}
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
  webview: {
    backgroundColor: '#000000',
    flex: 1,
  },
});

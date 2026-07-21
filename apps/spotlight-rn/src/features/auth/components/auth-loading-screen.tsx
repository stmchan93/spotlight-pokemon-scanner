import { Image, StyleSheet, View } from 'react-native';

import { colors } from '@spotlight/design-system';

/**
 * Shown while post-sign-in gates resolve — fonts/auth are already ready, but the
 * access-gate status is still fetching over the network. It mirrors the NATIVE
 * splash exactly: same `canvas` (#FCFCFA) background + the centered logo at
 * imageWidth 200 (see the expo-splash-screen config in app.json). That way the
 * handoff native-splash → this loader → app is seamless and never flashes a
 * blank white frame (the old version was an empty white SafeAreaView).
 */
export function AuthLoadingScreen() {
  return (
    <View style={styles.root} testID="auth-loading-screen">
      <Image
        resizeMode="contain"
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        source={require('../../../../assets/images/splash-icon.png')}
        style={styles.logo}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  logo: {
    height: 200,
    width: 200,
  },
  root: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    flex: 1,
    justifyContent: 'center',
  },
});

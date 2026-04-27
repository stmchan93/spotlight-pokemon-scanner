import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSpotlightTheme } from '@spotlight/design-system';

export function AuthLoadingScreen() {
  const theme = useSpotlightTheme();

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[
        styles.safeArea,
        {
          backgroundColor: theme.colors.canvas,
        },
      ]}
      testID="auth-loading-screen"
    >
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
});

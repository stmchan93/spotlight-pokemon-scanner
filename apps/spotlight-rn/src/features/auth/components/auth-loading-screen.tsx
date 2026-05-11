import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '@spotlight/design-system';

export function AuthLoadingScreen() {
  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[
        styles.safeArea,
        {
          backgroundColor: colors.gray0,
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

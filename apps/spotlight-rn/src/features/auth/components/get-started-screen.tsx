import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useSpotlightTheme } from '@spotlight/design-system';

type GetStartedScreenProps = {
  onGetStarted: () => void;
};

/**
 * Bare purple entry screen. Vertical space above the button is reserved for
 * future branding. Presentational only.
 */
export function GetStartedScreen({ onGetStarted }: GetStartedScreenProps) {
  const theme = useSpotlightTheme();

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: theme.colors.purple300 }]}
      testID="auth-get-started-screen"
    >
      <View style={styles.shell}>
        <View style={styles.spacer} />

        <Pressable
          accessibilityRole="button"
          onPress={onGetStarted}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.colors.gray900, opacity: pressed ? 0.9 : 1 },
          ]}
          testID="auth-get-started-button"
        >
          <Text style={[theme.typography.titleSmall, { color: theme.colors.gray0 }]}>
            Get started
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 8,
    justifyContent: 'center',
    minHeight: 48,
  },
  safeArea: {
    flex: 1,
  },
  shell: {
    flex: 1,
    paddingBottom: 28,
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  spacer: {
    flex: 1,
  },
});

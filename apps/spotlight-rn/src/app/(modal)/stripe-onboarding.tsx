import { Stack, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { StripeOnboardingEntry } from '@/features/payments/screens/stripe-onboarding-entry';

export default function StripeOnboardingModalRoute() {
  const router = useRouter();
  const theme = useSpotlightTheme();

  return (
    <>
      <Stack.Screen options={{ gestureEnabled: true, presentation: 'modal' }} />
      <SafeAreaView
        edges={['top', 'left', 'right', 'bottom']}
        style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingHorizontal: theme.layout.pageGutter,
              paddingTop: theme.layout.pageTopInset,
            },
          ]}
        >
          <View style={styles.header} testID="stripe-onboarding-modal-header">
            <ChromeBackButton
              onPress={() => router.back()}
              testID="stripe-onboarding-modal-close"
            />
          </View>
          <StripeOnboardingEntry testID="stripe-onboarding-modal-entry" />
        </ScrollView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 18,
    paddingBottom: 36,
  },
  header: {
    alignItems: 'flex-start',
  },
  safeArea: {
    flex: 1,
  },
});

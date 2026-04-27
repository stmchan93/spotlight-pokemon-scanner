import { Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, useSpotlightTheme } from '@spotlight/design-system';

type SignInScreenProps = {
  appleSignInAvailable: boolean;
  configurationIssue: string | null;
  errorMessage: string | null;
  isBusy: boolean;
  isConfigured: boolean;
  onAppleSignIn: () => void;
  onGoogleSignIn: () => void;
};

export function SignInScreen({
  appleSignInAvailable,
  configurationIssue,
  errorMessage,
  isBusy,
  isConfigured,
  onAppleSignIn,
  onGoogleSignIn,
}: SignInScreenProps) {
  const theme = useSpotlightTheme();
  const signInEnabled = isConfigured && !isBusy;
  const showsAppleSignIn = Platform.OS === 'ios' && appleSignInAvailable;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[
        styles.safeArea,
        {
          backgroundColor: theme.colors.brand,
        },
      ]}
      testID="auth-sign-in-screen"
    >
      <View style={styles.shell}>
        <View style={styles.content}>
          <Text
            style={[
              theme.typography.display,
              styles.title,
              { color: theme.colors.textPrimary },
            ]}
          >
            Sign into Loooty
          </Text>

          <View style={styles.actions}>
            {showsAppleSignIn ? (
              <Button
                disabled={!signInEnabled}
                label="Continue with Apple"
                labelStyleVariant="bodyStrong"
                onPress={onAppleSignIn}
                size="lg"
                style={[
                  styles.providerButton,
                  theme.shadows.card,
                  {
                    backgroundColor: theme.colors.canvasElevated,
                    borderColor: theme.colors.canvasElevated,
                  },
                ]}
                testID="auth-apple-button"
              />
            ) : null}

            <Button
              disabled={!signInEnabled}
              label="Continue with Google"
              labelStyleVariant="bodyStrong"
              onPress={onGoogleSignIn}
              size="lg"
              style={[
                styles.providerButton,
                styles.googleButton,
                {
                  borderColor: theme.colors.outlineStrong,
                },
              ]}
              testID="auth-google-button"
              variant="primary"
            />
          </View>

          {configurationIssue ? (
            <AuthMessage
              accent={theme.colors.info}
              message={configurationIssue}
            />
          ) : null}

          {errorMessage ? (
            <AuthMessage
              accent={theme.colors.danger}
              message={errorMessage}
            />
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

function AuthMessage({
  accent,
  message,
}: {
  accent: string;
  message: string;
}) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.messageRow}>
      <View style={[styles.messageDot, { backgroundColor: accent }]} />
      <Text style={[theme.typography.body, styles.messageText, { color: theme.colors.textPrimary }]}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 12,
    width: '100%',
  },
  content: {
    alignItems: 'center',
    gap: 24,
    width: '100%',
  },
  googleButton: {
    elevation: 0,
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: {
      width: 0,
      height: 0,
    },
  },
  messageDot: {
    borderRadius: 999,
    height: 10,
    marginTop: 4,
    width: 10,
  },
  messageRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    paddingHorizontal: 12,
    width: '100%',
  },
  messageText: {
    flex: 1,
    textAlign: 'center',
  },
  providerButton: {
    borderRadius: 24,
    minHeight: 64,
    width: '100%',
  },
  safeArea: {
    flex: 1,
  },
  shell: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'flex-end',
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 28,
  },
  title: {
    letterSpacing: -1.2,
    textAlign: 'center',
  },
});

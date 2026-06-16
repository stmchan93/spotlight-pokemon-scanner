import { Platform, StyleSheet, View } from 'react-native';
import { Apple, Google, Mail } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import { AuthWordmark } from './auth-wordmark';
import { PrimaryButton, SecondaryActionButton } from './auth-controls';

type GetStartedScreenProps = {
  appleSignInAvailable?: boolean;
  isBusy?: boolean;
  onContinueWithEmail: () => void;
  onGoogle: () => void;
  onApple: () => void;
};

/**
 * Pre-login homepage (Figma 1543:2210): a clean white entry screen — the
 * EKALIGHT wordmark + tagline centered, then "Continue with Email" (purple) and
 * "Continue with Google" (gray) actions. Presentational only; all auth happens
 * via the passed handlers.
 */
export function GetStartedScreen({
  appleSignInAvailable = false,
  isBusy = false,
  onContinueWithEmail,
  onGoogle,
  onApple,
}: GetStartedScreenProps) {
  const theme = useSpotlightTheme();
  // Apple Sign In is required alongside Google on iOS (App Store guideline 4.8),
  // so always offer it on iOS; on Android fall back to the runtime availability
  // flag (effectively hidden, since Apple auth isn't native there).
  const showApple = Platform.OS === 'ios' || appleSignInAvailable;

  return (
    <AuthScreenLayout onShare={null} testID="auth-get-started-screen">
      <View style={styles.topSpacer} />

      <AuthWordmark />

      <View style={styles.buttons}>
        <PrimaryButton
          disabled={isBusy}
          label="Continue with Email"
          leadingIcon={<Mail color={theme.colors.gray0} height={20} width={20} />}
          onPress={onContinueWithEmail}
          testID="auth-get-started-button"
        />
        <SecondaryActionButton
          disabled={isBusy}
          label="Continue with Google"
          leadingIcon={<Google color={theme.colors.gray900} height={20} width={20} />}
          onPress={onGoogle}
          testID="auth-google-button"
        />
        {showApple ? (
          <SecondaryActionButton
            disabled={isBusy}
            label="Continue with Apple"
            leadingIcon={<Apple color={theme.colors.gray900} height={20} width={20} />}
            onPress={onApple}
            testID="auth-apple-button"
          />
        ) : null}
      </View>

      <View style={styles.bottomSpacer} />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  bottomSpacer: {
    flex: 1.2,
  },
  buttons: {
    gap: 16,
    marginTop: 40,
  },
  topSpacer: {
    flex: 1,
  },
});

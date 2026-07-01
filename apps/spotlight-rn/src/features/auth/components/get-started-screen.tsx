import { Platform, StyleSheet, View } from 'react-native';
import { Apple, Google } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import { AuthWordmark } from './auth-wordmark';
import { PrimaryButton, SecondaryActionButton, TertiaryButton } from './auth-controls';

type GetStartedScreenProps = {
  appleSignInAvailable?: boolean;
  isBusy?: boolean;
  onSignUp: () => void;
  onLogIn: () => void;
  onGoogle: () => void;
  onApple: () => void;
};

/**
 * Pre-login homepage (Figma 1481:4380): a black entry screen behind the flowing
 * wave hero — the white EKALIGHT wordmark + tagline. Signup-led: a purple
 * "Sign Up" primary, then "Continue with Google"/"Continue with Apple", and a
 * "Already have an account? Log in" link at the bottom. This is the split entry
 * point — Sign Up and Log In are separate, deliberate choices (no auto-detect).
 * Presentational only; all auth happens via the passed handlers.
 */
export function GetStartedScreen({
  appleSignInAvailable = false,
  isBusy = false,
  onSignUp,
  onLogIn,
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
      <AuthWordmark />

      <View style={styles.buttons}>
        <PrimaryButton
          disabled={isBusy}
          label="Sign Up"
          onPress={onSignUp}
          testID="auth-get-started-signup"
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

      <TertiaryButton
        disabled={isBusy}
        label="Already have an account? Log in"
        onPress={onLogIn}
        testID="auth-get-started-login"
      />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  buttons: {
    gap: 16,
    marginTop: 40,
  },
});

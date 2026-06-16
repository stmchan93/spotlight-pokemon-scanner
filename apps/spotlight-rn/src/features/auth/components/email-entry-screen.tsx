import { StyleSheet, View } from 'react-native';

import { AuthScreenLayout } from './auth-screen-layout';
import { AuthWordmark } from './auth-wordmark';
import {
  AuthErrorLine,
  PrimaryButton,
  SecondaryField,
  isValidLookingEmail,
} from './auth-controls';

type EmailEntryScreenProps = {
  // Social handlers live on the entry screen now; kept optional so the stepper
  // can still pass them without rendering duplicate buttons here.
  appleSignInAvailable?: boolean;
  configurationIssue?: string | null;
  email: string;
  errorMessage?: string | null;
  isBusy: boolean;
  onApple?: () => void;
  onBack: () => void;
  onChangeEmail: (value: string) => void;
  onContinue: () => void;
  onGoogle?: () => void;
};

/**
 * Email entry (Figma 1481:4380): black wave-hero screen with the back header,
 * the EKALIGHT wordmark, a single email underline field, and a Continue button
 * that stays disabled until the address looks valid.
 */
export function EmailEntryScreen({
  configurationIssue,
  email,
  errorMessage,
  isBusy,
  onBack,
  onChangeEmail,
  onContinue,
}: EmailEntryScreenProps) {
  const canContinue = isValidLookingEmail(email) && !isBusy;

  return (
    <AuthScreenLayout
      backTestID="auth-email-back"
      onBack={onBack}
      testID="auth-email-entry-screen"
    >
      <AuthWordmark tagline={null} />

      <View style={styles.form}>
        <SecondaryField
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          onChangeText={onChangeEmail}
          onSubmitEditing={canContinue ? onContinue : undefined}
          placeholder="Email"
          returnKeyType="next"
          testID="auth-email-input"
          value={email}
        />

        {configurationIssue ? <AuthErrorLine message={configurationIssue} /> : null}
        {errorMessage ? <AuthErrorLine message={errorMessage} /> : null}

        <PrimaryButton
          disabled={!canContinue}
          label="Continue"
          onPress={onContinue}
          testID="auth-email-continue"
        />
      </View>
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: 16,
    marginTop: 40,
  },
});

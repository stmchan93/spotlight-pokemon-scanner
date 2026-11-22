import { StyleSheet, View } from 'react-native';

import { spacing } from '@spotlight/design-system';

import { AuthScreenLayout } from './auth-screen-layout';
import {
  AuthEmailBackChip,
  AuthErrorBlock,
  AuthErrorLine,
  AuthHeading,
  SocialAuthButtons,
  TermsFooter,
  TertiaryButton,
} from './auth-controls';

export type SocialAccountMethod = 'google' | 'apple' | 'oauth';

type SocialAccountScreenProps = {
  configurationIssue?: string | null;
  email: string;
  errorMessage?: string | null;
  isBusy: boolean;
  method: SocialAccountMethod;
  onApple: () => void;
  onBack: () => void;
  onGoogle: () => void;
};

const PROVIDER_COPY: Record<SocialAccountMethod, string> = {
  apple: 'This account signs in with Apple.',
  google: 'This account signs in with Google.',
  oauth: 'This account signs in with Google or Apple.',
};

/**
 * Email-first step 2 for an account created with Google/Apple: there is no
 * password to ask for, so offer the provider it was made with.
 */
export function SocialAccountScreen({
  configurationIssue,
  email,
  errorMessage,
  isBusy,
  method,
  onApple,
  onBack,
  onGoogle,
}: SocialAccountScreenProps) {
  return (
    <AuthScreenLayout
      backTestID="auth-social-back"
      footer={<TermsFooter />}
      onBack={onBack}
      testID="auth-social-account-screen"
    >
      <View style={styles.header}>
        <AuthEmailBackChip email={email} onPress={onBack} testID="auth-email-chip" />
        <AuthHeading subtitle={PROVIDER_COPY[method]} title="Welcome back" />
      </View>

      {configurationIssue ? <AuthErrorLine message={configurationIssue} /> : null}
      <AuthErrorBlock isBusy={isBusy} message={errorMessage} onGoogle={onGoogle} />

      <SocialAuthButtons
        isBusy={isBusy}
        onApple={onApple}
        onGoogle={onGoogle}
        showApple={method !== 'google'}
        showGoogle={method !== 'apple'}
      />

      <TertiaryButton
        disabled={isBusy}
        label="Not you? Use another email"
        onPress={onBack}
        testID="auth-social-use-another-email"
      />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.sm,
  },
});

export default SocialAccountScreen;

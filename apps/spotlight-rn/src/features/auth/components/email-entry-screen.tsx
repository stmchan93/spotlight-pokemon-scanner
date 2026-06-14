import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Apple, Google } from 'iconoir-react-native';

import { useSpotlightTheme } from '@spotlight/design-system';

import { AuthSheetLayout } from './auth-sheet-layout';
import {
  AuthErrorLine,
  PrimaryButton,
  SecondaryField,
  isValidLookingEmail,
} from './auth-controls';

type EmailEntryScreenProps = {
  appleSignInAvailable: boolean;
  configurationIssue?: string | null;
  email: string;
  errorMessage?: string | null;
  isBusy: boolean;
  onApple: () => void;
  onBack: () => void;
  onChangeEmail: (value: string) => void;
  onContinue: () => void;
  onGoogle: () => void;
};

export function EmailEntryScreen({
  appleSignInAvailable,
  configurationIssue,
  email,
  errorMessage,
  isBusy,
  onApple,
  onBack,
  onChangeEmail,
  onContinue,
  onGoogle,
}: EmailEntryScreenProps) {
  const theme = useSpotlightTheme();
  const canContinue = isValidLookingEmail(email) && !isBusy;
  const showAppleButton = Platform.OS === 'ios' && appleSignInAvailable;

  return (
    <AuthSheetLayout
      backTestID="auth-email-back"
      onBack={onBack}
      testID="auth-email-entry-screen"
    >
      <Text
        style={[
          theme.typography.titleMedium,
          styles.title,
          { color: theme.colors.gray800 },
        ]}
      >
        Login or sign up
      </Text>
      <Text
        style={[
          theme.typography.body,
          styles.subtitle,
          { color: theme.colors.gray600 },
        ]}
      >
        Scan, collect, sell, and build your ultimate collection.
      </Text>

      <SecondaryField
        autoCapitalize="none"
        autoCorrect={false}
        floatingLabel="Email"
        keyboardType="email-address"
        onChangeText={onChangeEmail}
        placeholder="Email"
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

      <View style={styles.dividerRow}>
        <View style={[styles.hairline, { backgroundColor: theme.colors.gray300 }]} />
        <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray400 }]}>
          or
        </Text>
        <View style={[styles.hairline, { backgroundColor: theme.colors.gray300 }]} />
      </View>

      <Pressable
        accessibilityRole="button"
        onPress={onGoogle}
        style={({ pressed }) => [
          styles.providerButton,
          {
            backgroundColor: theme.colors.gray0,
            borderColor: theme.colors.gray300,
            opacity: pressed ? 0.9 : 1,
          },
        ]}
        testID="auth-google-button"
      >
        <Google color={theme.colors.gray900} height={18} width={18} />
        <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
          Continue with Google
        </Text>
      </Pressable>

      {showAppleButton ? (
        <Pressable
          accessibilityRole="button"
          onPress={onApple}
          style={({ pressed }) => [
            styles.providerButton,
            {
              backgroundColor: theme.colors.gray0,
              borderColor: theme.colors.gray300,
              opacity: pressed ? 0.9 : 1,
            },
          ]}
          testID="auth-apple-button"
        >
          <Apple color={theme.colors.gray900} height={18} width={18} />
          <Text style={[theme.typography.bodyMedium, { color: theme.colors.gray900 }]}>
            Continue with Apple
          </Text>
        </Pressable>
      ) : null}
    </AuthSheetLayout>
  );
}

const styles = StyleSheet.create({
  dividerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  hairline: {
    flex: 1,
    height: 1,
  },
  providerButton: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'center',
    minHeight: 48,
  },
  subtitle: {
    textAlign: 'center',
  },
  title: {
    textAlign: 'center',
  },
});

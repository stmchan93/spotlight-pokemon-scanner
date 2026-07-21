import { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Button,
  SurfaceCard,
  Text,
  TextField,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { useAccessGate } from '@/features/auth/access-gate-provider';
import { useAuth } from '@/providers/auth-provider';
import { useAppServices } from '@/providers/app-providers';

/**
 * Public-launch holding screen shown to signed-in users who are not yet allowed
 * past the access gate. They can join the waitlist or redeem an invite code; a
 * successful redeem re-checks access and lets the app render.
 */
export function BetweenShowsScreen() {
  const theme = useSpotlightTheme();
  const auth = useAuth();
  const accessGate = useAccessGate();
  const { spotlightRepository } = useAppServices();

  const [email, setEmail] = useState(auth.currentUser?.email ?? '');
  const [waitlistJoined, setWaitlistJoined] = useState(false);
  const [waitlistBusy, setWaitlistBusy] = useState(false);

  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const handleJoinWaitlist = useCallback(async () => {
    const trimmed = email.trim();
    if (trimmed.length === 0 || waitlistBusy) {
      return;
    }
    setWaitlistBusy(true);
    try {
      const result = await spotlightRepository.joinAccessWaitlist(trimmed);
      if (result.ok) {
        setWaitlistJoined(true);
      }
    } catch {
      // Surface nothing destructive — the user can retry the submit.
    } finally {
      setWaitlistBusy(false);
    }
  }, [email, spotlightRepository, waitlistBusy]);

  const handleRedeem = useCallback(async () => {
    const trimmed = code.trim();
    if (trimmed.length === 0 || codeBusy) {
      return;
    }
    setCodeBusy(true);
    setCodeError(null);
    try {
      const result = await spotlightRepository.redeemInviteCode(trimmed);
      if (result.redeemed) {
        // Re-check access; a successful redeem flips the gate to allowed and the
        // provider renders the app in place of this screen.
        await accessGate.refresh();
        return;
      }
      setCodeError("That code didn't work.");
    } catch {
      setCodeError("That code didn't work.");
    } finally {
      setCodeBusy(false);
    }
  }, [accessGate, code, codeBusy, spotlightRepository]);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.safeArea, { backgroundColor: colors.gray0 }]}
      testID="between-shows-screen"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingBottom: 36,
              paddingHorizontal: theme.layout.pageGutter,
              paddingTop: theme.layout.pageTopInset,
            },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.headerCopy}>
            <Text style={[theme.typography.display, { color: theme.colors.textPrimary }]}>
              Ekalight is between shows.
            </Text>
            <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
              Drop your email for early access and we&apos;ll let you know when
              we&apos;re publicly available.
            </Text>
          </View>

          <SurfaceCard padding={20} radius={28}>
            {waitlistJoined ? (
              <View style={styles.cardCopy}>
                <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                  You&apos;re on the list.
                </Text>
                <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                  We&apos;ll email you the moment Ekalight opens up.
                </Text>
              </View>
            ) : (
              <View style={styles.cardCopy}>
                <TextField
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  keyboardType="email-address"
                  label="Email"
                  onChangeText={setEmail}
                  onSubmitEditing={() => {
                    void handleJoinWaitlist();
                  }}
                  placeholder="you@example.com"
                  testID="between-shows-email"
                  value={email}
                />
                <Button
                  disabled={waitlistBusy || email.trim().length === 0}
                  label={waitlistBusy ? 'Submitting…' : 'Get early access'}
                  onPress={() => {
                    void handleJoinWaitlist();
                  }}
                  size="lg"
                  testID="between-shows-waitlist-submit"
                />
              </View>
            )}
          </SurfaceCard>

          <SurfaceCard padding={20} radius={28}>
            <View style={styles.cardCopy}>
              <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                Have an invite code?
              </Text>
              <TextField
                autoCapitalize="none"
                autoCorrect={false}
                label="Invite code"
                onChangeText={(value) => {
                  setCode(value);
                  if (codeError) {
                    setCodeError(null);
                  }
                }}
                onSubmitEditing={() => {
                  void handleRedeem();
                }}
                placeholder="Enter your code"
                testID="between-shows-code"
                value={code}
              />
              {codeError ? (
                <Text style={[theme.typography.caption, { color: theme.colors.danger }]}>
                  {codeError}
                </Text>
              ) : null}
              <Button
                disabled={codeBusy || code.trim().length === 0}
                label={codeBusy ? 'Checking…' : 'Redeem code'}
                onPress={() => {
                  void handleRedeem();
                }}
                size="lg"
                testID="between-shows-redeem"
                variant="outline"
              />
            </View>
          </SurfaceCard>

          <Pressable
            accessibilityRole="button"
            disabled={auth.isBusy}
            onPress={() => {
              void auth.signOut();
            }}
            style={({ pressed }) => [
              styles.signOutButton,
              { opacity: pressed || auth.isBusy ? 0.6 : 1 },
            ]}
            testID="between-shows-sign-out"
          >
            <Text style={[theme.typography.control, { color: theme.colors.textSecondary }]}>
              Sign out
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  cardCopy: {
    gap: 14,
  },
  content: {
    flexGrow: 1,
    gap: 18,
  },
  flex: {
    flex: 1,
  },
  headerCopy: {
    gap: 10,
  },
  safeArea: {
    flex: 1,
  },
  signOutButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 18,
  },
});

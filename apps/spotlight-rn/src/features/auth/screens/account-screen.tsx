import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { VendorWalletHandles } from '@spotlight/api-client';
import {
  Button,
  SectionHeader,
  SurfaceCard,
  TextField,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { getResolvedDisplayName, getUserInitials } from '@/features/auth/auth-models';
import { useSuggestedDiscount } from '@/features/pricing/use-suggested-discount';
import { useAuth } from '@/providers/auth-provider';
import { useAppServices } from '@/providers/app-providers';

export function AccountScreen() {
  const router = useRouter();
  const theme = useSpotlightTheme();
  const auth = useAuth();
  const user = auth.currentUser;
  const canStartLabelingSession = !!(user?.labelerEnabled || user?.adminEnabled);
  const { spotlightRepository } = useAppServices();

  const { discountPct, setDiscountPct } = useSuggestedDiscount();
  const [discountText, setDiscountText] = useState<string>(
    discountPct == null ? '' : String(discountPct),
  );

  const [isDeleting, setIsDeleting] = useState(false);

  const [walletHandles, setWalletHandles] = useState<VendorWalletHandles | null>(null);
  const [venmoText, setVenmoText] = useState('');
  const [cashappText, setCashappText] = useState('');
  const [paypalText, setPaypalText] = useState('');
  const [zelleText, setZelleText] = useState('');

  useEffect(() => {
    void spotlightRepository.getVendorWalletHandles().then((handles) => {
      setWalletHandles(handles);
      setVenmoText(handles.venmoHandle ?? '');
      setCashappText(handles.cashappHandle ?? '');
      setPaypalText(handles.paypalMeSlug ?? '');
      setZelleText(handles.zelleEmailOrPhone ?? '');
    }).catch(() => {});
  }, [spotlightRepository]);

  const saveWalletHandles = useCallback((update: Partial<VendorWalletHandles>) => {
    if (!walletHandles) return;
    const merged = { ...walletHandles, ...update };
    setWalletHandles(merged);
    void spotlightRepository.updateVendorWalletHandles({
      venmoHandle: merged.venmoHandle ?? null,
      cashappHandle: merged.cashappHandle ?? null,
      paypalMeSlug: merged.paypalMeSlug ?? null,
      zelleEmailOrPhone: merged.zelleEmailOrPhone ?? null,
    }).catch(() => {});
  }, [spotlightRepository, walletHandles]);

  useEffect(() => {
    // Keep the input mirror in sync if the persisted value changes elsewhere
    // (e.g. async hydration on mount or another mount of this screen). We only
    // overwrite if the integer parse of the current text doesn't already match
    // the persisted value, so the user's in-progress typing isn't stomped.
    const parsed = discountText === '' ? null : Number.parseInt(discountText, 10);
    const parsedMatchesStored =
      (parsed == null && discountPct == null) ||
      (Number.isFinite(parsed) && parsed === discountPct);
    if (!parsedMatchesStored) {
      setDiscountText(discountPct == null ? '' : String(discountPct));
    }
  }, [discountPct, discountText]);

  const openLabelingSession = useCallback(() => {
    router.push('/labeling/session');
  }, [router]);

  const confirmDeleteAccount = useCallback(async () => {
    setIsDeleting(true);
    try {
      await spotlightRepository.deleteAccount();
      await auth.signOut();
    } catch {
      setIsDeleting(false);
      Alert.alert(
        'Could not delete account',
        'Something went wrong deleting your account. Please try again.',
      );
    }
  }, [auth, spotlightRepository]);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      'Delete account',
      'This permanently deletes your account and your whole collection. This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void confirmDeleteAccount();
          },
        },
      ],
    );
  }, [confirmDeleteAccount]);

  const handleDiscountChange = useCallback(
    (rawValue: string) => {
      // Allow only digits, max 3 characters; clamp to 0–100 and persist.
      const digitsOnly = rawValue.replace(/[^0-9]/g, '').slice(0, 3);
      setDiscountText(digitsOnly);

      if (digitsOnly === '') {
        setDiscountPct(null);
        return;
      }

      const parsed = Number.parseInt(digitsOnly, 10);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        return;
      }
      setDiscountPct(parsed);
    },
    [setDiscountPct],
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[
        styles.safeArea,
        {
          backgroundColor: colors.gray0,
        },
      ]}
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
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header} testID="account-header">
          <View style={styles.headerBackRow} testID="account-header-back-row">
            <ChromeBackButton
              onPress={() => router.back()}
              style={styles.closeButton}
              testID="account-close"
            />
          </View>

          <View style={styles.headerCopy}>
            <Text style={theme.typography.display}>Account</Text>
          </View>
        </View>

        <SurfaceCard padding={20} radius={28}>
          <View style={styles.identityRow}>
            <View
              style={[
                styles.avatar,
                {
                  backgroundColor: theme.colors.brand,
                },
              ]}
            >
              <Text style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
                {user ? getUserInitials(user) : '?'}
              </Text>
            </View>

            <View style={styles.identityCopy}>
              <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                {user ? getResolvedDisplayName(user) : 'Collector'}
              </Text>
              {user?.email ? (
                <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                  {user.email}
                </Text>
              ) : null}
            </View>
          </View>
        </SurfaceCard>

        <View style={styles.section} testID="account-pricing-section">
          <SectionHeader
            subtitle="Optional markdown applied to market prices when shown in the app."
            testID="account-pricing-header"
            title="Pricing"
          />
          <SurfaceCard padding={20} radius={28}>
            <TextField
              helperText="Leave empty to hide suggested price"
              keyboardType="number-pad"
              label="Suggested discount"
              maxLength={3}
              onChangeText={handleDiscountChange}
              placeholder="0"
              returnKeyType="done"
              testID="account-pricing-discount-input"
              trailing={
                <Text
                  style={[theme.typography.body, { color: theme.colors.textSecondary }]}
                  testID="account-pricing-discount-suffix"
                >
                  %
                </Text>
              }
              value={discountText}
            />
          </SurfaceCard>
        </View>

        <View style={styles.section} testID="account-payment-section">
          <SectionHeader
            subtitle="Used to generate QR codes and payment links when you sell."
            testID="account-payment-header"
            title="Payment handles"
          />
          <SurfaceCard padding={20} radius={28} style={styles.paymentCard}>
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              label="Venmo"
              leading={<Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>@</Text>}
              onBlur={() => saveWalletHandles({ venmoHandle: venmoText.replace(/^@/, '') || null })}
              onChangeText={setVenmoText}
              placeholder="username"
              returnKeyType="done"
              testID="account-payment-venmo"
              value={venmoText}
            />
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              label="Cash App"
              leading={<Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>$</Text>}
              onBlur={() => saveWalletHandles({ cashappHandle: cashappText.replace(/^\$/, '') || null })}
              onChangeText={setCashappText}
              placeholder="cashtag"
              returnKeyType="done"
              testID="account-payment-cashapp"
              value={cashappText}
            />
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              label="PayPal"
              leading={<Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>paypal.me/</Text>}
              onBlur={() => saveWalletHandles({ paypalMeSlug: paypalText || null })}
              onChangeText={setPaypalText}
              placeholder="slug"
              returnKeyType="done"
              testID="account-payment-paypal"
              value={paypalText}
            />
            <TextField
              autoCapitalize="none"
              autoCorrect={false}
              label="Zelle"
              onBlur={() => saveWalletHandles({ zelleEmailOrPhone: zelleText || null })}
              onChangeText={setZelleText}
              placeholder="Email or phone number"
              returnKeyType="done"
              testID="account-payment-zelle"
              value={zelleText}
            />
          </SurfaceCard>
        </View>

        {canStartLabelingSession ? (
          <SurfaceCard padding={20} radius={28}>
            <Pressable
              accessibilityLabel="Start label session"
              accessibilityRole="button"
              onPress={openLabelingSession}
              style={({ pressed }) => [
                styles.labelSessionButton,
                {
                  backgroundColor: theme.colors.brand,
                  opacity: pressed ? 0.9 : 1,
                },
              ]}
              testID="account-label-session"
            >
              <View style={styles.labelSessionCopy}>
                <Text style={[theme.typography.control, { color: theme.colors.textInverse }]}>
                  + Label Session
                </Text>
                <Text style={[theme.typography.caption, { color: theme.colors.textInverse }]}>
                  Capture labeling photos with the existing scanner flow.
                </Text>
              </View>
            </Pressable>
          </SurfaceCard>
        ) : null}

        <Pressable
          accessibilityRole="button"
          disabled={auth.isBusy}
          onPress={() => {
            void auth.signOut();
          }}
          style={[
            styles.signOutButton,
            {
              backgroundColor: theme.colors.danger,
              opacity: auth.isBusy ? 0.6 : 1,
            },
          ]}
          testID="account-sign-out"
        >
          <Text style={[theme.typography.control, { color: theme.colors.textPrimary }]}>
            Sign out
          </Text>
        </Pressable>

        <Button
          disabled={isDeleting || auth.isBusy}
          label="Delete Account"
          labelStyle={{ color: theme.colors.danger }}
          onPress={handleDeleteAccount}
          size="lg"
          testID="account-delete"
          variant="outline"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    borderRadius: 28,
    height: 56,
    justifyContent: 'center',
    width: 56,
  },
  content: {
    gap: 18,
  },
  closeButton: {
    flexShrink: 0,
  },
  header: {
    alignItems: 'flex-start',
    gap: 18,
  },
  headerBackRow: {
    alignSelf: 'flex-start',
  },
  headerCopy: {
    gap: 4,
  },
  identityCopy: {
    flex: 1,
    gap: 4,
  },
  identityRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  labelSessionButton: {
    borderRadius: 24,
    minHeight: 78,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  labelSessionCopy: {
    gap: 6,
  },
  safeArea: {
    flex: 1,
  },
  paymentCard: {
    gap: 16,
  },
  section: {
    gap: 12,
  },
  signOutButton: {
    alignItems: 'center',
    borderRadius: 20,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 18,
  },
});

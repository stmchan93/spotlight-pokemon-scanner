import { useCallback, useEffect, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  SurfaceCard,
  Text,
  TextField,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';


import { ChromeBackButton } from '@/components/chrome-back-button';
import { getResolvedDisplayName, getUserInitials } from '@/features/auth/auth-models';
import {
  PRIVACY_POLICY_URL,
  TERMS_OF_USE_URL,
  openLegalUrl,
} from '@/features/auth/legal-links';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import { exportCollectionCsv } from '@/features/portfolio/export-collection';
import { useAuth } from '@/providers/auth-provider';
import { useAppServices } from '@/providers/app-providers';

const ADMIN_EMAIL = 'stmchan8953@gmail.com';

// App Store Guideline 1.2 (user-generated content) requires a published contact
// method so anyone can reach us about objectionable content. This is also the
// human escape hatch when the automated filter misses something.
const SUPPORT_EMAIL = 'team@ekalight.com';

function buildSupportMailtoUrl() {
  const appName = Constants.expoConfig?.name ?? 'Ekalight';
  const appVersion = Constants.expoConfig?.version ?? '';
  // Subject only — never put user PII in the prefilled body.
  const subject = appVersion ? `${appName} ${appVersion} — Support` : `${appName} — Support`;
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

/**
 * App version plus the running JS bundle's identity, e.g. `1.2.0 · 019fece6 ·
 * 10 Aug 03:14`. Falls back to just the version when expo-updates is absent
 * (Expo Go, a dev client with updates disabled) or when running the bundle that
 * shipped inside the binary, which has no update id.
 *
 * Deliberately NOT a hook and NOT memoised on anything: the values are fixed for
 * the lifetime of the JS context, because applying an update restarts it.
 */
function resolveBuildStamp(): string {
  const version = Constants.expoConfig?.version ?? '';
  let updates: typeof import('expo-updates') | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    updates = require('expo-updates') as typeof import('expo-updates');
  } catch {
    updates = null;
  }

  const parts: string[] = [];
  if (version) {
    parts.push(version);
  }
  // `updateId` is null on the embedded bundle — that is meaningful, not missing:
  // it means no OTA has been applied yet.
  const updateId = updates?.updateId ?? null;
  parts.push(updateId ? updateId.slice(0, 8) : 'embedded');
  const createdAt = updates?.createdAt ?? null;
  if (createdAt) {
    parts.push(
      createdAt.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
  }
  return parts.join(' · ');
}

export function AccountScreen() {
  const router = useRouter();
  const buildStamp = resolveBuildStamp();
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const auth = useAuth();
  const user = auth.currentUser;
  const { isGuest, openLogin } = useGuestGate();
  const { spotlightRepository } = useAppServices();

  // Belt-and-suspenders: every entry point here is already guest-gated, but if a
  // guest somehow lands on this screen, bounce them to the login modal.
  useEffect(() => {
    if (isGuest) openLogin();
  }, [isGuest, openLogin]);

  const [isDeleting, setIsDeleting] = useState(false);
  const [collectionDataBusy, setCollectionDataBusy] = useState(false);
  const [supportEmailRevealed, setSupportEmailRevealed] = useState(false);
  const [supportEmailCopied, setSupportEmailCopied] = useState(false);

  const isAdmin = auth.currentUser?.email === ADMIN_EMAIL;
  const [showModeActive, setShowModeActive] = useState(false);
  const [showModeBusy, setShowModeBusy] = useState(false);
  const [whitelistEmails, setWhitelistEmails] = useState<string[]>([]);
  const [newWhitelistEmail, setNewWhitelistEmail] = useState('');
  const [whitelistBusy, setWhitelistBusy] = useState(false);

  useEffect(() => {
    if (!isAdmin) {
      return undefined;
    }

    let cancelled = false;
    void spotlightRepository
      .getAccessStatus()
      .then((status) => {
        if (!cancelled) {
          setShowModeActive(status.showMode.active);
        }
      })
      .catch(() => {
        // Leave the toggle in its default off state if the status can't load.
      });
    void spotlightRepository
      .getAccessWhitelist()
      .then((result) => {
        if (!cancelled) {
          setWhitelistEmails(result.emails);
        }
      })
      .catch(() => {
        // Leave the list empty if it can't load.
      });

    return () => {
      cancelled = true;
    };
  }, [isAdmin, spotlightRepository]);

  const handleAddWhitelistEmail = useCallback(async () => {
    const email = newWhitelistEmail.trim();
    if (!email || whitelistBusy) {
      return;
    }
    setWhitelistBusy(true);
    try {
      const result = await spotlightRepository.addAccessWhitelistEmail(email);
      setWhitelistEmails(result.emails);
      setNewWhitelistEmail('');
    } catch {
      Alert.alert('Could not add email', 'Check the address and try again.');
    } finally {
      setWhitelistBusy(false);
    }
  }, [newWhitelistEmail, whitelistBusy, spotlightRepository]);

  const handleRemoveWhitelistEmail = useCallback(
    async (email: string) => {
      if (whitelistBusy) {
        return;
      }
      setWhitelistBusy(true);
      try {
        const result = await spotlightRepository.removeAccessWhitelistEmail(email);
        setWhitelistEmails(result.emails);
      } catch {
        Alert.alert('Could not remove email', 'Please try again.');
      } finally {
        setWhitelistBusy(false);
      }
    },
    [whitelistBusy, spotlightRepository],
  );

  const handleToggleShowMode = useCallback(
    async (nextActive: boolean) => {
      if (showModeBusy) {
        return;
      }
      // Optimistically reflect the new position; revert on failure.
      const previousActive = showModeActive;
      setShowModeActive(nextActive);
      setShowModeBusy(true);
      try {
        await spotlightRepository.setCardShowMode(nextActive);
      } catch {
        setShowModeActive(previousActive);
        Alert.alert(
          'Could not update card show mode',
          'Something went wrong updating card show mode. Please try again.',
        );
      } finally {
        setShowModeBusy(false);
      }
    },
    [showModeActive, showModeBusy, spotlightRepository],
  );

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
      'This permanently deletes your account and your whole portfolio. This can’t be undone.',
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

  // `mailto:` rejects on simulators and on devices with no mail account set up.
  // This row is the contact-of-record for objectionable-content reports, so a
  // silent no-op is the one outcome we can't ship: fall back to showing the
  // address inline as selectable/copyable text.
  const handleContactSupport = useCallback(async () => {
    const url = buildSupportMailtoUrl();
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        setSupportEmailRevealed(true);
        return;
      }
      await Linking.openURL(url);
    } catch {
      setSupportEmailRevealed(true);
    }
  }, []);

  const handleCopySupportEmail = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(SUPPORT_EMAIL);
      setSupportEmailCopied(true);
    } catch {
      // The address is already on screen and selectable, so a failed clipboard
      // write is not a dead end — leave the label alone.
    }
  }, []);

  const handleExportCollection = useCallback(async () => {
    if (collectionDataBusy) {
      return;
    }
    setCollectionDataBusy(true);
    try {
      await exportCollectionCsv(spotlightRepository);
    } finally {
      setCollectionDataBusy(false);
    }
  }, [collectionDataBusy, spotlightRepository]);

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
            // Clear the Android system nav bar (3-button ~48dp) / iOS home
            // indicator so Sign out / Delete aren't covered. SafeAreaView omits
            // the bottom edge here, so add the real inset to the scroll content.
            paddingBottom: 36 + insets.bottom,
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

        <SurfaceCard padding={20} radius={28}>
          <View style={styles.collectionDataCard}>
            <View style={styles.showModeCopy}>
              <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                Collection data
              </Text>
              <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                Export your collection
              </Text>
            </View>
            <View style={styles.collectionDataButtons}>
              <Button
                disabled={collectionDataBusy}
                label={collectionDataBusy ? 'Exporting…' : 'Export portfolio (CSV)'}
                onPress={() => {
                  void handleExportCollection();
                }}
                size="lg"
                testID="account-export-csv"
                variant="outline"
              />
            </View>
          </View>
        </SurfaceCard>

        <SurfaceCard padding={20} radius={28}>
          <View style={styles.collectionDataCard}>
            <View style={styles.showModeCopy}>
              <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                Contact & support
              </Text>
              <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                Email us to report content or get help.
              </Text>
            </View>
            <View style={styles.collectionDataButtons}>
              <Button
                label="Contact support"
                onPress={() => {
                  void handleContactSupport();
                }}
                size="lg"
                testID="account-contact-support"
                variant="outline"
              />

              {supportEmailRevealed ? (
                <View style={styles.supportFallback}>
                  <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                    No mail app is set up on this device. Email us at:
                  </Text>
                  <Text
                    selectable
                    style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}
                    testID="account-support-email"
                  >
                    {SUPPORT_EMAIL}
                  </Text>
                  <Button
                    label={supportEmailCopied ? 'Copied' : 'Copy email address'}
                    onPress={() => {
                      void handleCopySupportEmail();
                    }}
                    size="md"
                    testID="account-support-copy"
                    variant="outline"
                  />
                </View>
              ) : null}
            </View>
          </View>
        </SurfaceCard>

        {/*
          Safety lives next to Contact & support because they answer the same
          question ("someone is bothering me"). Blocking used to be a one-way
          door — nothing in the app called `unblockUser` — so this is the only
          route back.
        */}
        <SurfaceCard padding={20} radius={28}>
          <View style={styles.collectionDataCard}>
            <View style={styles.showModeCopy}>
              <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                Safety
              </Text>
              <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                See who you&apos;ve blocked and unblock them.
              </Text>
            </View>
            <View style={styles.collectionDataButtons}>
              <Button
                label="Blocked accounts"
                onPress={() => {
                  router.push('/account/blocked' as never);
                }}
                size="lg"
                testID="account-blocked-accounts"
                variant="outline"
              />
            </View>
          </View>
        </SurfaceCard>

        {/*
          Legal sits with Safety and Contact & support: App Review (Guideline
          1.2 / 5.1.1) expects the Terms and Privacy Policy to be reachable from
          inside the app, not only from the sign-up footer.
        */}
        <SurfaceCard padding={20} radius={28}>
          <View style={styles.collectionDataCard}>
            <View style={styles.showModeCopy}>
              <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                Legal
              </Text>
              <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                The agreements that govern your use of Ekalight.
              </Text>
            </View>
            <View style={styles.collectionDataButtons}>
              <Button
                label="Terms of Use"
                onPress={() => {
                  openLegalUrl(TERMS_OF_USE_URL);
                }}
                size="lg"
                testID="account-terms"
                variant="outline"
              />
              <Button
                label="Privacy Policy"
                onPress={() => {
                  openLegalUrl(PRIVACY_POLICY_URL);
                }}
                size="lg"
                testID="account-privacy"
                variant="outline"
              />
            </View>
          </View>
        </SurfaceCard>

        {isAdmin ? (
          <SurfaceCard padding={20} radius={28}>
            <View style={styles.showModeRow}>
              <View style={styles.showModeCopy}>
                <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                  Card show mode
                </Text>
                <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                  Opens the access gate so everyone can use the app.
                </Text>
              </View>
              <Switch
                disabled={showModeBusy}
                onValueChange={(nextActive) => {
                  void handleToggleShowMode(nextActive);
                }}
                testID="account-show-mode-toggle"
                value={showModeActive}
              />
            </View>
          </SurfaceCard>
        ) : null}

        {isAdmin ? (
          <SurfaceCard padding={20} radius={28}>
            <View style={styles.whitelistCard}>
              <View style={styles.showModeCopy}>
                <Text style={[theme.typography.titleCompact, { color: theme.colors.textPrimary }]}>
                  Early-access whitelist
                </Text>
                <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                  These emails always have access, even when the gate is closed.
                </Text>
              </View>

              <View style={styles.whitelistInputRow}>
                <View style={styles.whitelistInput}>
                  <TextField
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    onChangeText={setNewWhitelistEmail}
                    onSubmitEditing={() => {
                      void handleAddWhitelistEmail();
                    }}
                    placeholder="name@email.com"
                    returnKeyType="done"
                    testID="account-whitelist-input"
                    value={newWhitelistEmail}
                  />
                </View>
                <Button
                  disabled={whitelistBusy || newWhitelistEmail.trim().length === 0}
                  label="Add"
                  onPress={() => {
                    void handleAddWhitelistEmail();
                  }}
                  size="md"
                  testID="account-whitelist-add"
                  variant="accent"
                />
              </View>

              {whitelistEmails.length > 0 ? (
                <View style={styles.whitelistList}>
                  {whitelistEmails.map((email) => (
                    <View key={email} style={styles.whitelistItem}>
                      <Text
                        numberOfLines={1}
                        style={[theme.typography.body, styles.whitelistEmail, { color: theme.colors.textPrimary }]}
                      >
                        {email}
                      </Text>
                      <Pressable
                        accessibilityLabel={`Remove ${email}`}
                        accessibilityRole="button"
                        disabled={whitelistBusy}
                        hitSlop={10}
                        onPress={() => {
                          void handleRemoveWhitelistEmail(email);
                        }}
                        testID={`account-whitelist-remove-${email}`}
                      >
                        <Text style={[theme.typography.control, { color: theme.colors.danger }]}>
                          Remove
                        </Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          </SurfaceCard>
        ) : null}

        <Button
          disabled={auth.isBusy}
          label="Change password"
          onPress={() => {
            router.push('/change-password' as never);
          }}
          size="lg"
          testID="account-change-password"
          variant="outline"
        />

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

        {/*
          WHICH JS BUNDLE AM I ACTUALLY RUNNING?

          `fallbackToCacheTimeout` is unset, so expo-updates defaults to 0: the
          app launches from the bundle it already has and fetches the new one in
          the BACKGROUND, which then applies on the NEXT launch. One cold start
          after a push therefore still runs the previous bundle — and there was
          no way to tell from inside the app, so "the fix didn't work" and "the
          fix hasn't loaded yet" looked identical during testing.

          This line ends that. Read the short id aloud against the OTA output and
          you know in one second which of the two you are looking at.
        */}
        <Text style={[theme.typography.caption, styles.buildStamp, { color: theme.colors.textSecondary }]} testID="account-build-stamp">
          {buildStamp}
        </Text>
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
  collectionDataCard: {
    gap: 16,
  },
  collectionDataButtons: {
    gap: 12,
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
  safeArea: {
    flex: 1,
  },
  showModeCopy: {
    flex: 1,
    gap: 4,
  },
  showModeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  supportFallback: {
    gap: 8,
  },
  whitelistCard: {
    gap: 16,
  },
  whitelistInputRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  whitelistInput: {
    flex: 1,
  },
  whitelistList: {
    gap: 12,
  },
  whitelistItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  whitelistEmail: {
    flex: 1,
  },
  signOutButton: {
    alignItems: 'center',
    borderRadius: 20,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 18,
  },
  // Diagnostic, not chrome: centred and quiet at the very bottom, below even the
  // destructive actions, so it is findable when you need it and invisible when
  // you do not.
  buildStamp: {
    marginTop: 8,
    textAlign: 'center',
  },
});

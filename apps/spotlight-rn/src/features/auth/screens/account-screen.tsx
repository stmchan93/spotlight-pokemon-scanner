import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Button,
  SurfaceCard,
  TextField,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';


import { ChromeBackButton } from '@/components/chrome-back-button';
import { getResolvedDisplayName, getUserInitials } from '@/features/auth/auth-models';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import { exportCollectionCsv } from '@/features/portfolio/export-collection';
import { useAuth } from '@/providers/auth-provider';
import { useAppServices } from '@/providers/app-providers';

const ADMIN_EMAIL = 'stmchan8953@gmail.com';

export function AccountScreen() {
  const router = useRouter();
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
                Export your whole collection as a spreadsheet (CSV) — it&apos;s yours to keep.
              </Text>
            </View>
            <View style={styles.collectionDataButtons}>
              <Button
                disabled={collectionDataBusy}
                label={collectionDataBusy ? 'Exporting…' : 'Export collection (CSV)'}
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
});

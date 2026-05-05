import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SurfaceCard, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { getResolvedDisplayName, getUserInitials } from '@/features/auth/auth-models';
import { useAuth } from '@/providers/auth-provider';

export function AccountScreen() {
  const router = useRouter();
  const theme = useSpotlightTheme();
  const auth = useAuth();
  const user = auth.currentUser;
  const canStartLabelingSession = !!(user?.labelerEnabled || user?.adminEnabled);

  const openLabelingSession = useCallback(() => {
    router.push('/labeling/session');
  }, [router]);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[
        styles.safeArea,
        {
          backgroundColor: theme.colors.canvas,
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
  signOutButton: {
    alignItems: 'center',
    borderRadius: 20,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: 18,
  },
});

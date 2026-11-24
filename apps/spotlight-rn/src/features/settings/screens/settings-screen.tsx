import { useRouter } from 'expo-router';
import {
  ChatBubbleEmpty,
  Download,
  EditPencil,
  GraphUp,
  LogOut,
  MagicWand,
  MessageText,
  NavArrowRight,
  Settings,
  Star,
} from 'iconoir-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Avatar,
  ScreenHeader,
  Text,
  borderWidths,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import { exportCollectionCsv } from '@/features/portfolio/export-collection';
import { getProfileInitials } from '@/features/profile/screens/public-profile-screen';
import { openStoreReviewPage } from '@/features/review-prompt/review-prompt';
import { ExportScopeSheet } from '@/features/settings/components/export-scope-sheet';
import { useUnreadMessageCount } from '@/features/social/use-unread-message-count';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';
import type { Collection } from '@spotlight/api-client';

type SettingsItem = {
  key: string;
  label: string;
  icon: typeof Settings;
  /** Unread count drawn as a pill. 0/absent draws nothing. */
  badgeCount?: number;
  destructive?: boolean;
  onPress: () => void;
};

const ROW_ICON_SIZE = 20;
const PROFILE_AVATAR_SIZE = 48;
/** Outlasts the export-scope sheet's slide-out before the share sheet opens. */
const EXPORT_SHEET_DISMISS_MS = 400;

/**
 * Settings — what the gear in Home's top bar opens (Figma 6642:6202). It
 * REPLACES the hamburger drawer: every destination the drawer listed is a row
 * here, except "Find people", which the Search tab's PEOPLE results replace.
 *
 * A pushed stack screen, so every row is a plain `router.push` and back-swipe
 * returns to Home — none of the drawer's replace-vs-push bookkeeping is needed.
 *
 * Gated rows (signed-in destinations) send a guest to sign-in, as the drawer
 * did. Send Feedback and Rate are open to guests: losing a guest's bug report
 * to a sign-in wall costs more than it protects.
 */
export function SettingsScreen({ testID = 'settings' }: { testID?: string }) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const auth = useAuth();
  const { gate } = useGuestGate();
  const unreadMessageCount = useUnreadMessageCount();
  const { spotlightRepository } = useAppServices();
  const [exportBusy, setExportBusy] = useState(false);
  // Non-null while the "All / one collection" sheet is up.
  const [exportChoices, setExportChoices] = useState<Collection[] | null>(null);

  useEffect(() => {
    capturePostHogEvent(AnalyticsEvent.settingsOpened, {});
  }, []);

  // Logged before the guest gate, so a guest's tap on a gated row still counts.
  const tracked = useCallback(
    (item: string, onPress: () => void) => () => {
      capturePostHogEvent(AnalyticsEvent.settingsItemTapped, { item });
      onPress();
    },
    [],
  );

  const runExport = useCallback(
    async (collectionId: string | null) => {
      const props = { scope: collectionId ? 'single' : 'all', source: 'settings' } as const;
      capturePostHogEvent(AnalyticsEvent.collectionExportTapped, props);
      setExportBusy(true);
      try {
        const outcome = await exportCollectionCsv(spotlightRepository, collectionId);
        if (outcome === 'failed') {
          capturePostHogEvent(AnalyticsEvent.collectionExportFailed, props);
        } else {
          capturePostHogEvent(AnalyticsEvent.collectionExportSucceeded, {
            ...props,
            empty: outcome === 'empty',
          });
        }
      } finally {
        setExportBusy(false);
      }
    },
    [spotlightRepository],
  );

  // One collection exports straight away; more than one asks All vs which one.
  // A failed collections read falls back to exporting everything.
  const startExport = useCallback(async () => {
    if (exportBusy) {
      return;
    }
    setExportBusy(true);
    let collections: Collection[] = [];
    try {
      collections = (await spotlightRepository.listCollections()).collections;
    } catch {
      collections = [];
    } finally {
      setExportBusy(false);
    }
    if (collections.length > 1) {
      setExportChoices(collections);
      return;
    }
    await runExport(null);
  }, [exportBusy, runExport, spotlightRepository]);

  const user = auth.currentUser;
  const displayName = user?.displayName?.trim() || 'You';
  const handle = user?.handle?.trim() || null;

  const confirmLogOut = () => {
    Alert.alert('Log out?', "You'll need to sign in again to view your portfolio.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out',
        style: 'destructive',
        onPress: async () => {
          try {
            await auth.signOut();
            if (router.canGoBack()) {
              router.back();
            }
          } catch (error) {
            console.warn('[Settings] signOut failed', error);
          }
        },
      },
    ]);
  };

  const sections: SettingsItem[][] = [
    [
      {
        key: 'edit-profile',
        label: 'Edit profile',
        icon: EditPencil,
        onPress: tracked('edit_profile', gate(() => router.push('/edit-profile' as never))),
      },
      {
        key: 'insights',
        label: 'Insights',
        icon: GraphUp,
        onPress: tracked('insights', gate(() => router.push('/insights' as never))),
      },
      {
        key: 'messages',
        label: 'Messages',
        icon: ChatBubbleEmpty,
        badgeCount: unreadMessageCount,
        onPress: tracked('messages', gate(() => router.push('/messages' as never))),
      },
      {
        key: 'whos-that-pokemon',
        label: "Who's That Pokémon?",
        icon: MagicWand,
        onPress: tracked('whos_that_pokemon', gate(() => router.push('/whos-that-pokemon' as never))),
      },
      {
        key: 'export-collection',
        label: exportBusy ? 'Exporting…' : 'Export collection',
        icon: Download,
        onPress: tracked('export_collection', gate(() => {
          void startExport();
        })),
      },
    ],
    [
      {
        key: 'rate',
        label: 'Rate Ekalight',
        icon: Star,
        onPress: tracked('rate', () => {
          void openStoreReviewPage();
        }),
      },
      {
        key: 'feedback',
        label: 'Send Feedback',
        icon: MessageText,
        onPress: tracked('feedback', () =>
          router.push({ pathname: '/feedback', params: { from: '/settings' } } as never)),
      },
      {
        // The Account page carries blocked accounts, vendor pricing,
        // AI access, legal, change password, sign-out and delete-account.
        key: 'account-settings',
        label: 'Account Settings',
        icon: Settings,
        onPress: tracked('account_settings', gate(() => router.push('/account' as never))),
      },
      {
        key: 'logout',
        label: 'Log Out',
        icon: LogOut,
        destructive: true,
        onPress: tracked('logout', gate(confirmLogOut)),
      },
    ],
  ];

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.screen, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <ScrollView
        contentContainerStyle={{
          paddingBottom: insets.bottom + spacing.lg,
          paddingHorizontal: theme.layout.pageGutter,
        }}
        showsVerticalScrollIndicator={false}
      >
        <ScreenHeader
          accessoryTestID={`${testID}-back-row`}
          layout="stacked"
          leftAccessory={<ChromeBackButton onPress={() => router.back()} testID={`${testID}-back`} />}
          style={styles.header}
          title="Settings"
        />

        {user ? (
          <Pressable
            accessibilityLabel="Edit profile"
            accessibilityRole="button"
            onPress={tracked('profile', () => router.push('/edit-profile' as never))}
            style={({ pressed }) => [
              styles.profileRow,
              { backgroundColor: theme.colors.gray50, opacity: pressed ? 0.7 : 1 },
            ]}
            testID={`${testID}-profile`}
          >
            <Avatar initials={getProfileInitials(displayName)} size={PROFILE_AVATAR_SIZE} uri={user.avatarURL} />
            <View style={styles.profileCopy}>
              <Text numberOfLines={1} style={[theme.typography.headline, { color: theme.colors.gray900 }]}>
                {handle ?? displayName}
              </Text>
              {handle && displayName !== handle ? (
                <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
                  {displayName}
                </Text>
              ) : null}
            </View>
            <NavArrowRight color={theme.colors.gray600} height={ROW_ICON_SIZE} width={ROW_ICON_SIZE} />
          </Pressable>
        ) : null}

        {sections.map((items, index) => (
          <View
            key={items[0]?.key ?? index}
            style={[styles.section, { borderTopColor: theme.colors.gray200 }]}
            testID={`${testID}-section-${index}`}
          >
            {items.map((item) => (
              <SettingsRow item={item} key={item.key} testID={`${testID}-row-${item.key}`} />
            ))}
          </View>
        ))}
      </ScrollView>
      <ExportScopeSheet
        collections={exportChoices ?? []}
        onChoose={(collectionId) => {
          setExportChoices(null);
          setExportBusy(true);
          // The share sheet can't present while this modal is still sliding out
          // (iOS view-controller collision), so start once it's gone.
          setTimeout(() => {
            void runExport(collectionId);
          }, EXPORT_SHEET_DISMISS_MS);
        }}
        onClose={() => setExportChoices(null)}
        visible={exportChoices != null}
      />
    </SafeAreaView>
  );
}

function SettingsRow({ item, testID }: { item: SettingsItem; testID: string }) {
  const theme = useSpotlightTheme();
  const { icon: Icon } = item;
  const ink = item.destructive ? theme.colors.dangerStrong : theme.colors.gray900;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={item.onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.7 : 1 }]}
      testID={testID}
    >
      <Icon color={ink} height={ROW_ICON_SIZE} width={ROW_ICON_SIZE} />
      {/* Uppercased in JS, not `textTransform` (see the design-system casing rule). */}
      <Text style={[theme.typography.captionMedium, styles.rowLabel, { color: ink }]}>
        {item.label.toUpperCase()}
      </Text>
      {item.badgeCount != null && item.badgeCount > 0 ? (
        // The inbox's own purple pill: unread mail is not a warning.
        <View style={[styles.badge, { backgroundColor: theme.colors.purple500 }]} testID={`${testID}-badge`}>
          <Text style={[theme.typography.overline, { color: theme.colors.gray0 }]}>
            {item.badgeCount > 99 ? '99+' : String(item.badgeCount)}
          </Text>
        </View>
      ) : null}
      {item.destructive ? null : (
        <NavArrowRight color={theme.colors.gray500} height={ROW_ICON_SIZE} width={ROW_ICON_SIZE} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    justifyContent: 'center',
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  header: {
    paddingBottom: spacing.xs,
    paddingTop: spacing.xxs,
  },
  profileCopy: {
    flex: 1,
    gap: 2,
  },
  profileRow: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.xs,
    padding: spacing.sm,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
    minHeight: 48,
  },
  rowLabel: {
    flex: 1,
  },
  section: {
    borderTopWidth: borderWidths.rule,
    paddingVertical: spacing.xxs,
  },
  screen: {
    flex: 1,
  },
});

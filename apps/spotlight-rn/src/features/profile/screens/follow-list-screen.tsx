import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  PageTabs,
  type PageTab,
  StateCard,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import type { UserProfile } from '@/features/auth/auth-models';
import {
  fetchFollowers,
  fetchFollowing,
  fetchProfileById,
} from '@/features/profile/profile-service';
import { ProfileListRow } from '@/features/profile/components/profile-list-row';
import { getProfileDisplayName } from '@/features/profile/screens/public-profile-screen';

/** Has the list loaded yet, and did it come back empty? */
type ListStatus = 'loading' | 'ready' | 'empty';

type FollowListMode = 'followers' | 'following';

export type FollowListScreenProps = {
  /** Whose graph we're listing. */
  userID: string;
  /** `followers` = people who follow them; `following` = people they follow. */
  mode: FollowListMode;
  /**
   * Toolbar title — the profile's name (Figma 5753:13043). Resolved from the
   * profile when omitted; falls back to the mode's own name.
   */
  title?: string;
  /** Back affordance; omit to hide the back button. */
  onBack?: () => void;
  testID?: string;
};

/**
 * Followers / Following list (Phase 2b). Loads the follow graph for one user via
 * `fetchFollowers` / `fetchFollowing` and renders a tappable row per profile that
 * routes to that person's public profile. The reads are moderation-filtered at
 * the source, so blocked/suspended users simply never appear.
 *
 * Both lists sit behind one tab rail (Figma 5753:12867), so the screen opens on
 * `mode` and can switch without a second route push.
 */
export function FollowListScreen({
  userID,
  mode,
  title,
  onBack,
  testID = 'follow-list',
}: FollowListScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [activeMode, setActiveMode] = useState<FollowListMode>(mode);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [ownerName, setOwnerName] = useState<string | null>(null);

  useEffect(() => {
    setActiveMode(mode);
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setProfiles([]);

    void (async () => {
      const fetched =
        activeMode === 'followers' ? await fetchFollowers(userID) : await fetchFollowing(userID);
      if (cancelled) {
        return;
      }
      setProfiles(fetched);
      setStatus(fetched.length === 0 ? 'empty' : 'ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [activeMode, userID]);

  // Only when no title was routed in: the toolbar names the profile whose
  // graph this is, and a failed lookup simply leaves the mode's fallback.
  useEffect(() => {
    if (title || !userID) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const profile = await fetchProfileById(userID);
        if (!cancelled && profile) {
          setOwnerName(getProfileDisplayName(profile));
        }
      } catch {
        // Fallback title stands.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [title, userID]);

  const handlePressRow = useCallback(
    (profile: UserProfile) => {
      const handle = profile.handle?.trim();
      // Route to /u/<handle> when they have one, else /u/<userId>. Passing an
      // explicit userId lets the public route skip the handle lookup entirely.
      router.push({
        pathname: '/u/[handle]',
        params: {
          handle: handle && handle.length > 0 ? handle : profile.userID,
          userId: profile.userID,
        },
      });
    },
    [router],
  );

  const headerTitle =
    title ?? ownerName ?? (activeMode === 'followers' ? 'Followers' : 'Following');

  // The active tab carries its count once the list has resolved (Figma "120
  // FOLLOWERS"); the other tab keeps its bare name until it is opened.
  const countLabel = (tabMode: FollowListMode, name: string) =>
    tabMode === activeMode && status !== 'loading' ? `${profiles.length} ${name}` : name;
  const tabs: readonly PageTab<FollowListMode>[] = [
    { value: 'followers', label: countLabel('followers', 'Followers') },
    { value: 'following', label: countLabel('following', 'Following') },
  ];

  const renderItem = useCallback(
    ({ item }: { item: UserProfile }) => (
      <ProfileListRow onPress={handlePressRow} profile={item} testID={`${testID}-row-${item.userID}`} />
    ),
    [handlePressRow, testID],
  );

  const listEmpty = (
    <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
      <StateCard
        loading={status === 'loading'}
        message={
          status === 'loading'
            ? 'Fetching this list.'
            : activeMode === 'followers'
              ? 'No followers yet.'
              : 'Not following anyone yet.'
        }
        style={styles.stateCard}
        testID={status === 'loading' ? `${testID}-loading` : `${testID}-empty`}
        title={status === 'loading' ? 'Loading' : 'Nothing here yet'}
        variant="field"
      />
    </View>
  );

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray50 }]}
      testID={testID}
    >
      <FlatList
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        data={status === 'ready' ? profiles : []}
        ItemSeparatorComponent={RowGap}
        keyExtractor={(item) => item.userID}
        ListEmptyComponent={listEmpty}
        ListHeaderComponent={
          <View style={[styles.header, { backgroundColor: theme.colors.gray0 }]}>
            <View
              style={[styles.toolbar, { paddingHorizontal: theme.layout.pageGutter }]}
              testID={`${testID}-toolbar`}
            >
              {onBack ? (
                <ChromeBackButton
                  onPress={onBack}
                  style={[styles.toolbarBack, { left: theme.layout.pageGutter }]}
                  testID={`${testID}-back`}
                />
              ) : null}
              <Text numberOfLines={1} style={theme.typography.titleMedium}>
                {headerTitle}
              </Text>
            </View>
            <PageTabs
              labelSize="caption"
              onChange={setActiveMode}
              tabs={tabs}
              testID={`${testID}-tabs`}
              uppercase
              value={activeMode}
            />
          </View>
        }
        renderItem={renderItem}
        testID={`${testID}-scroll-view`}
      />
    </SafeAreaView>
  );
}

function RowGap() {
  return <View style={styles.rowGap} />;
}

const styles = StyleSheet.create({
  header: {
    marginBottom: 4,
  },
  rowGap: {
    height: 4,
  },
  safeArea: {
    flex: 1,
  },
  stateCard: {
    marginTop: 12,
  },
  toolbar: {
    alignItems: 'center',
    height: 56,
    justifyContent: 'center',
    marginBottom: 12,
  },
  toolbarBack: {
    position: 'absolute',
  },
});

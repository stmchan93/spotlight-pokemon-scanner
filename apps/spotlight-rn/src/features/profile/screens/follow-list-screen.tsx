import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Avatar,
  ScreenHeader,
  StateCard,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import type { UserProfile } from '@/features/auth/auth-models';
import { fetchFollowers, fetchFollowing } from '@/features/profile/profile-service';
import {
  getProfileDisplayName,
  getProfileInitials,
} from '@/features/profile/screens/public-profile-screen';

/** Has the list loaded yet, and did it come back empty? */
type ListStatus = 'loading' | 'ready' | 'empty';

export type FollowListScreenProps = {
  /** Whose graph we're listing. */
  userID: string;
  /** `followers` = people who follow them; `following` = people they follow. */
  mode: 'followers' | 'following';
  /** Header title override; defaults to "Followers" / "Following". */
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

  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [status, setStatus] = useState<ListStatus>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setProfiles([]);

    void (async () => {
      const fetched =
        mode === 'followers' ? await fetchFollowers(userID) : await fetchFollowing(userID);
      if (cancelled) {
        return;
      }
      setProfiles(fetched);
      setStatus(fetched.length === 0 ? 'empty' : 'ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [mode, userID]);

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

  const headerTitle = title ?? (mode === 'followers' ? 'Followers' : 'Following');

  const renderItem = useCallback(
    ({ item }: { item: UserProfile }) => {
      const displayName = getProfileDisplayName(item);
      const handle = item.handle?.trim();
      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => handlePressRow(item)}
          style={({ pressed }) => [
            styles.row,
            { borderBottomColor: theme.colors.gray200 },
            pressed ? styles.rowPressed : null,
          ]}
          testID={`${testID}-row-${item.userID}`}
        >
          <Avatar
            initials={getProfileInitials(item.displayName)}
            size={44}
            testID={`${testID}-row-${item.userID}-avatar`}
            uri={item.avatarURL}
          />
          <View style={styles.rowCopy}>
            <Text numberOfLines={1} style={theme.typography.bodyStrong}>
              {displayName}
            </Text>
            {handle ? (
              <Text
                numberOfLines={1}
                style={[theme.typography.captionMedium, { color: theme.colors.gray500 }]}
              >
                @{handle}
              </Text>
            ) : null}
          </View>
        </Pressable>
      );
    },
    [handlePressRow, testID, theme],
  );

  const listEmpty = (
    <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
      <StateCard
        loading={status === 'loading'}
        message={
          status === 'loading'
            ? 'Fetching this list.'
            : mode === 'followers'
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
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <FlatList
        contentContainerStyle={{
          paddingHorizontal: theme.layout.pageGutter,
          paddingBottom: insets.bottom + 24,
        }}
        data={status === 'ready' ? profiles : []}
        keyExtractor={(item) => item.userID}
        ListEmptyComponent={listEmpty}
        ListHeaderComponent={
          <ScreenHeader
            // Back button on its own row above the title, matching Search Cards
            // — they are the same kind of screen and were laid out two
            // different ways.
            accessoryTestID={`${testID}-back-row`}
            layout="stacked"
            leftAccessory={
              onBack ? (
                <ChromeBackButton onPress={onBack} testID={`${testID}-back`} />
              ) : undefined
            }
            style={styles.header}
            title={headerTitle}
          />
        }
        renderItem={renderItem}
        testID={`${testID}-scroll-view`}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingBottom: 12,
    paddingTop: 8,
  },
  row: {
    alignItems: 'center',
    // Hairline under every row, the DM-inbox treatment — a list of people
    // reads as a list, not a floating column of avatars.
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 12,
  },
  rowCopy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  rowPressed: {
    opacity: 0.6,
  },
  safeArea: {
    flex: 1,
  },
  stateCard: {
    marginTop: 12,
  },
});

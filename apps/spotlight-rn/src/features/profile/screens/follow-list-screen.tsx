import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CheckCircle } from 'iconoir-react-native';

import {
  Avatar,
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
          style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
          testID={`${testID}-row-${item.userID}`}
        >
          <Avatar
            initials={getProfileInitials(item.displayName)}
            size={40}
            testID={`${testID}-row-${item.userID}-avatar`}
            uri={item.avatarURL}
          />
          <View style={styles.rowCopy}>
            <View style={styles.nameRow}>
              <Text numberOfLines={1} style={[theme.typography.bodyMedium, styles.nameText]}>
                {displayName}
              </Text>
              {item.isVerified ? (
                <CheckCircle
                  color={theme.colors.purple500}
                  height={16}
                  testID={`${testID}-row-${item.userID}-verified`}
                  width={16}
                />
              ) : null}
            </View>
            {handle ? (
              <Text
                numberOfLines={1}
                style={[theme.typography.label, { color: theme.colors.gray600 }]}
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
          <View style={styles.toolbar} testID={`${testID}-toolbar`}>
            {onBack ? (
              <ChromeBackButton
                onPress={onBack}
                style={styles.toolbarBack}
                testID={`${testID}-back`}
              />
            ) : null}
            <Text numberOfLines={1} style={theme.typography.titleMedium}>
              {headerTitle}
            </Text>
          </View>
        }
        renderItem={renderItem}
        testID={`${testID}-scroll-view`}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  nameText: {
    flexShrink: 1,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
  },
  rowCopy: {
    flex: 1,
    gap: 4,
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
  toolbar: {
    alignItems: 'center',
    height: 56,
    justifyContent: 'center',
    marginBottom: 16,
  },
  toolbarBack: {
    left: 0,
    position: 'absolute',
  },
});

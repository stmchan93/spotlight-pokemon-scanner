import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { StateCard, Text, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import type { UserProfile } from '@/features/auth/auth-models';
import { ProfileListRow } from '@/features/profile/components/profile-list-row';
import { fetchPostLikers } from '@/features/profile/profile-service';

/**
 * "Liked by": everyone who liked a post, most recent first, each row opening
 * their profile. Same rows as Followers; blocked/suspended users never appear
 * (moderation-filtered profile view).
 */
export function PostLikesScreen({
  postId,
  onBack,
  testID = 'post-likes',
}: {
  postId: string;
  onBack?: () => void;
  testID?: string;
}) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty'>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void (async () => {
      const likers = await fetchPostLikers(postId);
      if (!cancelled) {
        setProfiles(likers);
        setStatus(likers.length === 0 ? 'empty' : 'ready');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [postId]);

  const openProfile = useCallback(
    (profile: UserProfile) => {
      const handle = profile.handle?.trim();
      router.push({
        pathname: '/u/[handle]',
        params: { handle: handle && handle.length > 0 ? handle : profile.userID, userId: profile.userID },
      });
    },
    [router],
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
        ListEmptyComponent={
          <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
            <StateCard
              loading={status === 'loading'}
              message={status === 'loading' ? 'Fetching likes.' : 'No likes yet.'}
              style={styles.stateCard}
              testID={status === 'loading' ? `${testID}-loading` : `${testID}-empty`}
              title={status === 'loading' ? 'Loading' : 'Nothing here yet'}
              variant="field"
            />
          </View>
        }
        ListHeaderComponent={
          <View
            style={[styles.toolbar, { backgroundColor: theme.colors.gray0, paddingHorizontal: theme.layout.pageGutter }]}
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
              {status === 'ready' ? `${profiles.length} ${profiles.length === 1 ? 'Like' : 'Likes'}` : 'Likes'}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <ProfileListRow onPress={openProfile} profile={item} testID={`${testID}-row-${item.userID}`} />
        )}
      />
    </SafeAreaView>
  );
}

function RowGap() {
  return <View style={styles.rowGap} />;
}

const styles = StyleSheet.create({
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
    marginBottom: 16,
  },
  toolbarBack: {
    position: 'absolute',
  },
});

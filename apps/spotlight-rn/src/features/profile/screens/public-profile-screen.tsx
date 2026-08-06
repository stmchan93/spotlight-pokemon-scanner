import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { InventoryCardEntry, ProfilePortfolioSummary } from '@spotlight/api-client';
import {
  Button,
  InlineLoader,
  PageTabs,
  type PageTab,
  StateCard,
  Text,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import type { UserProfile } from '@/features/auth/auth-models';
import {
  CollectionGridRow,
  CollectionGridSingleRow,
  chunkCollectionGridRows,
} from '@/features/portfolio/components/collection-masonry-grid';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import {
  fetchProfileByHandle,
  fetchProfileById,
  followUser,
  isFollowing,
  unfollowUser,
} from '@/features/profile/profile-service';
import { ProfileHeader } from '@/features/profile/components/profile-header';
import { PostCard } from '@/features/social/components/post-card';
import { type FeedPost, fetchAuthorPosts } from '@/features/social/social-service';
import { resolveRepositoryBaseUrl, useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

const GRID_TEST_ID = 'public-profile-collection-grid';

// Cards fetched per request. The backend clamps `limit` to 1000; 200 keeps the
// first paint quick and lets onEndReached pull the rest.
const COLLECTION_PAGE_SIZE = 200;

// Same three tabs the owner sees on their own Portfolio. Only Collection is
// live; Activity renders this collector's posts (Phase 3a). For Sale is still
// the gated "Coming soon" state.
type ProfileTab = 'collection' | 'forsale' | 'activity';
const PROFILE_TABS: readonly PageTab<ProfileTab>[] = [
  { value: 'collection', label: 'Collection' },
  { value: 'forsale', label: 'For Sale' },
  { value: 'activity', label: 'Activity' },
];

/** Has the profile row itself resolved? */
type ProfileStatus = 'loading' | 'ready' | 'not-found';
/** Has the visitor-visible collection loaded? */
type CollectionStatus = 'idle' | 'loading' | 'ready' | 'error';
/**
 * Does the signed-in viewer follow this profile? `null` while the initial
 * `isFollowing` read is in flight — the button stays disabled until it resolves.
 */
type FollowState = 'following' | 'not-following' | null;

// One virtualized row of the visitor-facing card grid (two tiles per ruled row,
// or a single boxed tile when the portfolio holds exactly one card).
type PublicCollectionRow =
  | { kind: 'grid'; key: string; rowEntries: InventoryCardEntry[]; rowIndex: number }
  | { kind: 'grid-single'; key: string; entry: InventoryCardEntry }
  | { kind: 'post'; key: string; post: FeedPost };

/** Has this profile's Activity posts loaded? */
type ActivityStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Initials for a profile we only know from `user_profiles` (no auth user, so no
 * email fallback). Mirrors `getUserInitials` for the display-name case.
 */
export function getProfileInitials(displayName: string | null | undefined): string {
  const words = (displayName ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const letters = words.map((word) => word[0]?.toUpperCase() ?? '').filter(Boolean);
  return letters.length > 0 ? letters.join('') : 'C';
}

/** Display name for someone else's profile — never their email, which is private. */
export function getProfileDisplayName(profile: UserProfile | null): string {
  const name = profile?.displayName?.trim();
  if (name) {
    return name;
  }
  const handle = profile?.handle?.trim();
  return handle ? `@${handle}` : 'Collector';
}

export type PublicProfileScreenProps = {
  /** @handle from the route. Resolved first when present. */
  handle?: string | null;
  /** Supabase user id — the fallback lane for handle-less users. */
  userId?: string | null;
  /** Back affordance; omit to hide the back button (e.g. embedded previews). */
  onBack?: () => void;
  /** Tapping one of the visitor-visible cards. */
  onOpenEntry?: (entry: InventoryCardEntry) => void;
  testID?: string;
};

/**
 * Read-only public profile (Phase 2a). A signed-in visitor can look at someone
 * else's Portfolio: header, the Collection grid with per-card values, and the
 * portfolio total — a confirmed product decision that this is fully public.
 *
 * Deliberately NOT here: the price chart / dashboard. That read is expensive
 * per owner and stays owner-only. There is also no Follow button yet — that is
 * Phase 2b.
 */
export function PublicProfileScreen({
  handle,
  userId,
  onBack,
  onOpenEntry,
  testID = 'public-profile',
}: PublicProfileScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const auth = useAuth();
  // The signed-in viewer. Used to hide the Follow button on your own profile
  // (you can't follow yourself) and to seed the initial isFollowing read.
  const viewerId = auth.currentUser?.id ?? null;
  // Backend proxy base + bearer for the authed post-media images (Phase 3a).
  const accessToken = auth.accessToken;
  const apiBaseUrl = resolveRepositoryBaseUrl();

  const [activeTab, setActiveTab] = useState<ProfileTab>('collection');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('loading');
  const [entries, setEntries] = useState<InventoryCardEntry[]>([]);
  const [summary, setSummary] = useState<ProfilePortfolioSummary | null>(null);
  const [collectionStatus, setCollectionStatus] = useState<CollectionStatus>('idle');
  // Follow graph (Phase 2b). `followState` is null until the initial isFollowing
  // read lands. `displayFollowerCount` is the header count with the viewer's
  // optimistic follow/unfollow folded in; `followPending` de-dupes taps.
  const [followState, setFollowState] = useState<FollowState>(null);
  const [displayFollowerCount, setDisplayFollowerCount] = useState(0);
  const [followPending, setFollowPending] = useState(false);
  // Paging state. The header shows the target's TRUE card count, so rendering a
  // single capped page would quietly under-show a large collection.
  const [hasMoreEntries, setHasMoreEntries] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  // Activity tab (Phase 3a): this collector's posts. Fetched lazily the first
  // time the tab is opened, then cached for the rest of the visit.
  const [activityPosts, setActivityPosts] = useState<FeedPost[]>([]);
  const [activityStatus, setActivityStatus] = useState<ActivityStatus>('idle');
  // Which user's Activity posts have already been requested this visit, so
  // re-selecting the tab doesn't refetch. Reset when the profile changes.
  const activityLoadedRef = useRef<string | null>(null);

  // Resolve the profile from Supabase first (handle, then user-id fallback), and
  // only then ask the backend for their holdings — so a profile we can't see
  // never triggers a card read.
  useEffect(() => {
    let cancelled = false;

    setProfileStatus('loading');
    setProfile(null);
    setEntries([]);
    setSummary(null);
    setCollectionStatus('idle');
    setHasMoreEntries(false);
    setIsLoadingMore(false);
    setFollowState(null);
    setFollowPending(false);
    setActivityPosts([]);
    setActivityStatus('idle');
    activityLoadedRef.current = null;
    loadingMoreRef.current = false;

    void (async () => {
      const byHandle = handle ? await fetchProfileByHandle(handle) : null;
      const resolved = byHandle ?? (userId ? await fetchProfileById(userId) : null);
      if (cancelled) {
        return;
      }

      if (!resolved) {
        setProfileStatus('not-found');
        return;
      }

      setProfile(resolved);
      setProfileStatus('ready');
      setDisplayFollowerCount(resolved.followerCount ?? 0);
      setCollectionStatus('loading');

      try {
        const [loadedEntries, loadedSummary] = await Promise.all([
          spotlightRepository.getProfileDeckEntries(resolved.userID, {
            limit: COLLECTION_PAGE_SIZE,
            offset: 0,
          }),
          spotlightRepository.getProfilePortfolioSummary(resolved.userID),
        ]);
        if (cancelled) {
          return;
        }
        setEntries(loadedEntries);
        setSummary(loadedSummary);
        setHasMoreEntries(loadedEntries.length >= COLLECTION_PAGE_SIZE);
        setCollectionStatus('ready');
      } catch {
        if (cancelled) {
          return;
        }
        setCollectionStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handle, spotlightRepository, userId]);

  // Append the next page when the grid nears its end. `loadingMoreRef` guards the
  // burst of onEndReached calls FlatList fires while the fetch is still in flight;
  // state alone lands too late to stop a duplicate request.
  const handleLoadMoreEntries = useCallback(() => {
    const userID = profile?.userID;
    if (!userID || !hasMoreEntries || loadingMoreRef.current || collectionStatus !== 'ready') {
      return;
    }

    loadingMoreRef.current = true;
    setIsLoadingMore(true);

    void (async () => {
      try {
        const nextPage = await spotlightRepository.getProfileDeckEntries(userID, {
          limit: COLLECTION_PAGE_SIZE,
          offset: entries.length,
        });
        setEntries((current) => [...current, ...nextPage]);
        setHasMoreEntries(nextPage.length >= COLLECTION_PAGE_SIZE);
      } catch {
        // Keep what's already on screen and stop paging rather than blanking the
        // grid — the visitor still sees a usable collection.
        setHasMoreEntries(false);
      } finally {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    })();
  }, [collectionStatus, entries.length, hasMoreEntries, profile?.userID, spotlightRepository]);

  // You can follow this profile only if it's someone else. `viewerId === userID`
  // (your own profile) or a signed-out viewer both hide the button.
  const targetUserId = profile?.userID ?? null;
  const canFollow = Boolean(targetUserId && viewerId && viewerId !== targetUserId);

  // Seed the follow toggle once the profile is someone else's. Kept separate from
  // the profile-resolution effect so a re-check doesn't refetch the collection.
  useEffect(() => {
    if (!canFollow || !targetUserId) {
      setFollowState(null);
      return;
    }

    let cancelled = false;
    setFollowState(null);
    void isFollowing(targetUserId).then((following) => {
      if (!cancelled) {
        setFollowState(following ? 'following' : 'not-following');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [canFollow, targetUserId]);

  // Lazily load this collector's posts the first time the Activity tab opens.
  // Keyed on the profile so switching profiles refetches; guarded so re-selecting
  // the tab doesn't re-hit the network.
  useEffect(() => {
    if (activeTab !== 'activity' || !targetUserId || activityLoadedRef.current === targetUserId) {
      return;
    }

    activityLoadedRef.current = targetUserId;
    let cancelled = false;
    setActivityStatus('loading');
    void (async () => {
      const loaded = await fetchAuthorPosts(targetUserId);
      if (cancelled) {
        return;
      }
      setActivityPosts(loaded);
      setActivityStatus('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTab, targetUserId]);

  // Optimistically flip the button AND the header follower count, then reconcile:
  // roll both back if the write returns false. The screen stays interactive — only
  // this one control is guarded against a double-tap while the write is in flight.
  const handleToggleFollow = useCallback(() => {
    if (!targetUserId || followPending || followState === null) {
      return;
    }

    const wasFollowing = followState === 'following';
    const nextFollowing = !wasFollowing;

    setFollowState(nextFollowing ? 'following' : 'not-following');
    setDisplayFollowerCount((count) => count + (nextFollowing ? 1 : -1));
    setFollowPending(true);

    void (async () => {
      const ok = await (nextFollowing ? followUser(targetUserId) : unfollowUser(targetUserId));
      if (!ok) {
        // Reconcile: the write failed, so undo the optimistic flip + count.
        setFollowState(wasFollowing ? 'following' : 'not-following');
        setDisplayFollowerCount((count) => count + (nextFollowing ? -1 : 1));
      }
      setFollowPending(false);
    })();
  }, [followPending, followState, targetUserId]);

  // Header chips → this collector's followers / following lists. `/u/[handle]`
  // when they've claimed a handle, else `/u/<userId>`; the explicit `userId`
  // param lets the list route skip the handle lookup.
  const followListParams = useMemo(() => {
    if (!targetUserId) {
      return null;
    }
    const handleSlug = profile?.handle?.trim();
    return {
      handle: handleSlug && handleSlug.length > 0 ? handleSlug : targetUserId,
      userId: targetUserId,
    };
  }, [profile?.handle, targetUserId]);

  const handleOpenFollowers = useCallback(() => {
    if (followListParams) {
      router.push({ pathname: '/u/[handle]/followers', params: followListParams });
    }
  }, [followListParams, router]);

  const handleOpenFollowing = useCallback(() => {
    if (followListParams) {
      router.push({ pathname: '/u/[handle]/following', params: followListParams });
    }
  }, [followListParams, router]);

  const handleSocialLinkPress = useCallback(() => {
    const link = profile?.socialLink;
    if (!link) {
      return;
    }
    const url = /^https?:\/\//i.test(link) ? link : `https://${link}`;
    void Linking.openURL(url).catch(() => {});
  }, [profile?.socialLink]);

  const handlePressEntry = useCallback(
    (entry: InventoryCardEntry) => {
      onOpenEntry?.(entry);
    },
    [onOpenEntry],
  );

  const listData = useMemo<PublicCollectionRow[]>(() => {
    if (activeTab === 'activity') {
      return activityPosts.map((post) => ({ kind: 'post', key: post.id, post }));
    }
    if (activeTab !== 'collection' || entries.length === 0) {
      return [];
    }
    if (entries.length === 1) {
      return [{ kind: 'grid-single', key: entries[0].id, entry: entries[0] }];
    }
    return chunkCollectionGridRows(entries).map((rowEntries, rowIndex) => ({
      kind: 'grid',
      key: rowEntries[0]?.id ?? `grid-row-${rowIndex}`,
      rowEntries,
      rowIndex,
    }));
  }, [activeTab, activityPosts, entries]);

  const handleOpenCard = useCallback(
    (cardId: string) => {
      router.push({ pathname: '/cards/[cardId]', params: { cardId } });
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: PublicCollectionRow }) => {
      if (item.kind === 'post') {
        // Full-bleed post card (Figma 2903-7128): the card owns its inner padding
        // and its image spans edge-to-edge, so no page-gutter wrapper here.
        return (
          <PostCard
            accessToken={accessToken}
            apiBaseUrl={apiBaseUrl}
            onPressCard={handleOpenCard}
            post={item.post}
            testID={`${testID}-post`}
          />
        );
      }
      if (item.kind === 'grid-single') {
        return (
          <CollectionGridSingleRow
            entry={item.entry}
            onPressEntry={handlePressEntry}
            testID={GRID_TEST_ID}
          />
        );
      }
      return (
        <CollectionGridRow
          isFirstRow={item.rowIndex === 0}
          onPressEntry={handlePressEntry}
          rowEntries={item.rowEntries}
          rowIndex={item.rowIndex}
          testID={GRID_TEST_ID}
        />
      );
    },
    [accessToken, apiBaseUrl, handleOpenCard, handlePressEntry, testID],
  );

  const backButton = onBack ? (
    <ChromeBackButton
      onPress={onBack}
      style={[
        styles.backButton,
        { left: theme.layout.pageGutter, top: insets.top + 8 },
      ]}
      testID={`${testID}-back`}
    />
  ) : null;

  if (profileStatus !== 'ready') {
    return (
      <SafeAreaView
        edges={['top', 'left', 'right']}
        style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
        testID={testID}
      >
        <View style={[styles.centered, { paddingHorizontal: theme.layout.pageGutter }]}>
          {profileStatus === 'loading' ? (
            <StateCard
              centered
              loading
              message="Fetching this collector's profile."
              testID={`${testID}-loading`}
              title="Loading profile"
              variant="field"
            />
          ) : (
            <StateCard
              centered
              message="This profile doesn't exist, or it isn't available right now."
              testID={`${testID}-not-found`}
              title="Profile not found"
              variant="field"
            />
          )}
        </View>
        {backButton}
      </SafeAreaView>
    );
  }

  const displayName = getProfileDisplayName(profile);
  const totalLabel = summary
    ? formatCurrency(summary.totalValue, summary.currency)
    : null;

  const listHeader = (
    <View style={styles.chrome}>
      <ProfileHeader
        avatarUrl={profile?.avatarURL}
        bio={profile?.bio}
        displayName={displayName}
        followerCount={displayFollowerCount}
        followingCount={profile?.followingCount}
        handle={profile?.handle}
        initials={getProfileInitials(profile?.displayName)}
        isVerified={profile?.isVerified}
        onFollowersPress={handleOpenFollowers}
        onFollowingPress={handleOpenFollowing}
        onSocialLinkPress={handleSocialLinkPress}
        reputation={profile?.reputation}
        socialLink={profile?.socialLink}
        testID={`${testID}-header`}
      />

      {canFollow ? (
        <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
          <Button
            disabled={followState === null}
            label={followState === 'following' ? 'Following' : 'Follow'}
            onPress={handleToggleFollow}
            testID={`${testID}-follow-button`}
            variant={followState === 'following' ? 'secondary' : 'dark'}
          />
        </View>
      ) : null}

      <PageTabs
        onChange={setActiveTab}
        tabs={PROFILE_TABS}
        testID={`${testID}-tabs`}
        value={activeTab}
      />

      {activeTab === 'activity' ? null : activeTab === 'forsale' ? (
        <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
          <StateCard
            message="For Sale is coming soon."
            style={styles.stateCard}
            title="Coming soon"
            variant="field"
          />
        </View>
      ) : collectionStatus === 'error' ? (
        <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
          <StateCard
            message="Please try again in a moment."
            style={styles.stateCard}
            testID={`${testID}-collection-error`}
            title="Could not load this collection"
            variant="field"
          />
        </View>
      ) : (
        // Visitor-visible portfolio headline. Total value + card count only —
        // no chart, by design (the dashboard read is owner-only).
        <View
          style={[styles.totalBlock, { paddingHorizontal: theme.layout.pageGutter }]}
          testID={`${testID}-total`}
        >
          <Text
            style={[theme.typography.captionMedium, { color: theme.colors.gray500 }]}
          >
            Portfolio
          </Text>
          <Text
            style={theme.typography.displayLarge}
            testID={`${testID}-total-value`}
          >
            {totalLabel ?? '—'}
          </Text>
          <Text
            style={[theme.typography.captionMedium, { color: theme.colors.gray500 }]}
            testID={`${testID}-total-count`}
          >
            {`${summary?.cardCount ?? entries.length} card${(summary?.cardCount ?? entries.length) === 1 ? '' : 's'}`}
          </Text>
        </View>
      )}
    </View>
  );

  const listEmpty =
    activeTab === 'activity' ? (
      // Loading is a chromeless spinner; only the settled empty state earns a card.
      activityStatus === 'ready' ? (
        <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
          <StateCard
            message="This collector has no posts yet."
            style={styles.stateCard}
            testID={`${testID}-activity-empty`}
            title="No posts yet"
            variant="field"
          />
        </View>
      ) : (
        <InlineLoader label="Fetching posts" testID={`${testID}-activity-empty`} />
      )
    ) : activeTab !== 'collection' || collectionStatus === 'error' ? null : (
      collectionStatus === 'loading' ? (
        <InlineLoader label="Fetching cards" testID={`${testID}-collection-empty`} />
      ) : (
        <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
          <StateCard
            message="This collector has no cards in their portfolio yet."
            style={styles.stateCard}
            testID={`${testID}-collection-empty`}
            title="Nothing here yet"
            variant="field"
          />
        </View>
      )
    );

  const listFooter =
    activeTab === 'collection' && isLoadingMore ? (
      <View style={styles.footerSpinner}>
        <ActivityIndicator
          color={theme.colors.textSecondary}
          testID={`${testID}-collection-loading-more`}
        />
      </View>
    ) : null;

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      <FlatList
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        data={listData}
        keyExtractor={(item) => item.key}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={listFooter}
        ListHeaderComponent={listHeader}
        onEndReached={handleLoadMoreEntries}
        onEndReachedThreshold={0.5}
        renderItem={renderItem}
        testID={`${testID}-scroll-view`}
      />
      {backButton}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  backButton: {
    position: 'absolute',
    zIndex: 5,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
  },
  chrome: {
    // Match the owner Portfolio's header chrome rhythm.
    gap: 16,
    paddingBottom: 16,
  },
  footerSpinner: {
    paddingVertical: 20,
  },
  safeArea: {
    flex: 1,
  },
  stateCard: {
    marginTop: 12,
  },
  totalBlock: {
    gap: 4,
  },
});

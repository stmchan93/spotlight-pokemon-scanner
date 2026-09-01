import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type FlatList,
  Linking,
  type ScrollView,
  StyleSheet,
  View,
} from 'react-native';
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
  Toast,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  AnimatedFlatList,
  AnimatedScrollView,
  CollapsibleTabPager,
  type CollapsiblePageProps,
  type CollapsibleScrollTarget,
} from '@/components/page-tab-pager';
import type { UserProfile } from '@/features/auth/auth-models';
import { FOR_SALE_TAB_ENABLED } from '@/features/profile/for-sale-tab';
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
import { normalizeSocialLink } from '@/features/profile/social-link';
import { ProfileHeader } from '@/features/profile/components/profile-header';
import { findOrCreateDm } from '@/features/social/dm-service';
import { PostCard } from '@/features/social/components/post-card';
import { RepostAttribution } from '@/features/social/components/repost-attribution';
import {
  type AuthorActivityItem,
  type FeedPost,
  fetchAuthorActivity,
} from '@/features/social/social-service';
import { resolveRepositoryBaseUrl, useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

const GRID_TEST_ID = 'public-profile-collection-grid';
// The pager mounts every page at once, so the Wishlist grid needs its own
// testID root — sharing GRID_TEST_ID would emit duplicate tile testIDs.
const WISHLIST_GRID_TEST_ID = 'public-profile-wishlist-grid';

// Cards fetched per request. The backend clamps `limit` to 1000; 200 keeps the
// first paint quick and lets onEndReached pull the rest.
const COLLECTION_PAGE_SIZE = 200;

// Collection, Wishlist ("what they're hunting"), and Activity are live; For Sale
// is still the gated "Coming soon" state. Wishlist is public by the same rule
// Collection already follows — any signed-in visitor may read it.
type ProfileTab = 'collection' | 'wishlist' | 'forsale' | 'activity';
const ALL_PROFILE_TABS: readonly PageTab<ProfileTab>[] = [
  { value: 'collection', label: 'Collection' },
  { value: 'wishlist', label: 'Wishlist' },
  { value: 'forsale', label: 'For Sale' },
  { value: 'activity', label: 'Activity' },
];
// For Sale is hidden until the feature exists — see `FOR_SALE_TAB_ENABLED` for
// why this is a filter rather than a deleted line. Every For Sale render path
// below stays live and type-checked.
const PROFILE_TABS = ALL_PROFILE_TABS.filter(
  (tab) => tab.value !== 'forsale' || FOR_SALE_TAB_ENABLED,
);
// Left→right order the horizontal page swipe walks. Derived from PROFILE_TABS so
// the two can never disagree about which tab is "next".
const PROFILE_TAB_ORDER = PROFILE_TABS.map((tab) => tab.value);

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
  | {
      kind: 'grid';
      key: string;
      rowEntries: InventoryCardEntry[];
      rowIndex: number;
      /** Closes the grid's bottom edge — only the final row carries it. */
      isLastRow: boolean;
    }
  | { kind: 'grid-single'; key: string; entry: InventoryCardEntry }
  /** `repostedAt` set = this collector passed the post on rather than wrote it. */
  | { kind: 'post'; key: string; post: FeedPost; repostedAt: string | null };

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
  /**
   * Tab to open on, from a shared deep link (`?tab=wishlist`). Defaults to
   * Collection. Only the INITIAL tab — the visitor is free to switch after.
   */
  initialTab?: ProfileTab;
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
  initialTab,
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

  // A deep link may name the opening tab. Fall back to Collection when it names
  // one that isn't currently offered — `PROFILE_TABS` filters out gated tabs, and
  // landing on a page with no tab in the bar would strand the visitor.
  const [activeTab, setActiveTab] = useState<ProfileTab>(
    initialTab && PROFILE_TAB_ORDER.includes(initialTab) ? initialTab : 'collection',
  );
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
  // DM entry point. `messagePending` only dims the control; the REF is the real
  // double-tap guard — `findOrCreateDm` can be two round trips, and two taps
  // landing in the same tick would both read a stale `false` from state and push
  // the thread twice (same reason `loadingMoreRef` exists below).
  const [messagePending, setMessagePending] = useState(false);
  const [messageFailed, setMessageFailed] = useState(false);
  const messagePendingRef = useRef(false);
  // One scroller per page tab. The pager keeps their vertical offsets in step so
  // a horizontal swipe can never reveal a page whose header sits somewhere else.
  const collectionScrollRef = useRef<FlatList<PublicCollectionRow>>(null);
  const wishlistScrollRef = useRef<FlatList<PublicCollectionRow>>(null);
  const forSaleScrollRef = useRef<ScrollView>(null);
  const activityScrollRef = useRef<FlatList<PublicCollectionRow>>(null);
  const pageScrollRefs = useMemo<
    Partial<Record<ProfileTab, { readonly current: CollapsibleScrollTarget | null }>>
  >(
    () => ({
      collection: collectionScrollRef,
      wishlist: wishlistScrollRef,
      forsale: forSaleScrollRef,
      activity: activityScrollRef,
    }),
    [],
  );
  // Paging state. The header shows the target's TRUE card count, so rendering a
  // single capped page would quietly under-show a large collection.
  const [hasMoreEntries, setHasMoreEntries] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  // Wishlist tab: the cards this collector is hunting. Same lazy-on-first-open
  // contract as Activity below — the read is the same expensive per-owner
  // inventory computation as Collection, so it is not paid for until asked for.
  const [wishlistEntries, setWishlistEntries] = useState<InventoryCardEntry[]>([]);
  const [wishlistStatus, setWishlistStatus] = useState<CollectionStatus>('idle');
  const [wishlistHasMore, setWishlistHasMore] = useState(false);
  const [wishlistLoadingMore, setWishlistLoadingMore] = useState(false);
  const wishlistLoadingMoreRef = useRef(false);
  const wishlistLoadedRef = useRef<string | null>(null);
  // Activity tab (Phase 3a): this collector's posts. Fetched lazily the first
  // time the tab is opened, then cached for the rest of the visit.
  const [activityPosts, setActivityPosts] = useState<AuthorActivityItem[]>([]);
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
    setMessagePending(false);
    setMessageFailed(false);
    setWishlistEntries([]);
    setWishlistStatus('idle');
    setWishlistHasMore(false);
    setWishlistLoadingMore(false);
    wishlistLoadedRef.current = null;
    wishlistLoadingMoreRef.current = false;
    setActivityPosts([]);
    setActivityStatus('idle');
    activityLoadedRef.current = null;
    loadingMoreRef.current = false;
    messagePendingRef.current = false;

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
  //
  // Message is gated on exactly the same predicate, and not by coincidence:
  // `findOrCreateDm` refuses a self-DM (there are no note-to-self threads) and
  // needs a signed-in caller, so on your own profile the control could only ever
  // fail. Hiding it is the honest treatment — a visibly dead button is worse.
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

  // Lazily load this collector's wishlist the first time the Wishlist tab opens.
  // Same guard shape as Activity: keyed on the profile so switching collectors
  // refetches, and ref-guarded so re-selecting the tab doesn't re-hit the network.
  useEffect(() => {
    if (activeTab !== 'wishlist' || !targetUserId || wishlistLoadedRef.current === targetUserId) {
      return;
    }

    wishlistLoadedRef.current = targetUserId;
    let cancelled = false;
    setWishlistStatus('loading');
    void (async () => {
      try {
        const loaded = await spotlightRepository.getProfileWishlistEntries(targetUserId, {
          limit: COLLECTION_PAGE_SIZE,
          offset: 0,
        });
        if (cancelled) {
          return;
        }
        setWishlistEntries(loaded);
        setWishlistHasMore(loaded.length >= COLLECTION_PAGE_SIZE);
        setWishlistStatus('ready');
      } catch {
        if (!cancelled) {
          // Allow a retry on the next open rather than pinning the error for
          // the rest of the visit.
          wishlistLoadedRef.current = null;
          setWishlistStatus('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTab, spotlightRepository, targetUserId]);

  // Page the wishlist for the same reason the collection pages: a capped first
  // page would quietly under-show a long hunt list.
  const handleLoadMoreWishlist = useCallback(() => {
    if (
      !targetUserId ||
      !wishlistHasMore ||
      wishlistLoadingMoreRef.current ||
      wishlistStatus !== 'ready'
    ) {
      return;
    }

    wishlistLoadingMoreRef.current = true;
    setWishlistLoadingMore(true);

    void (async () => {
      try {
        const nextPage = await spotlightRepository.getProfileWishlistEntries(targetUserId, {
          limit: COLLECTION_PAGE_SIZE,
          offset: wishlistEntries.length,
        });
        setWishlistEntries((current) => [...current, ...nextPage]);
        setWishlistHasMore(nextPage.length >= COLLECTION_PAGE_SIZE);
      } catch {
        // Keep what's on screen and stop paging rather than blanking the grid.
        setWishlistHasMore(false);
      } finally {
        wishlistLoadingMoreRef.current = false;
        setWishlistLoadingMore(false);
      }
    })();
  }, [spotlightRepository, targetUserId, wishlistEntries.length, wishlistHasMore, wishlistStatus]);

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
      // Activity = what they wrote AND what they passed on, newest act first.
      const loaded = await fetchAuthorActivity(targetUserId);
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
    /*
      Move the VIEWER's own following count too, not just the target's follower
      count sitting above this line.

      The database was always right — the `follows` trigger is SECURITY DEFINER
      and updates both profiles — but the viewer's number is rendered from
      `currentUser`, which is read at sign-in and never re-read. So following
      someone visibly bumped THEIR followers while the viewer's own Following
      stayed put, which reads as the follow half-working.

      Optimistic and symmetrical with the line above: same trigger, same revert.
    */
    auth.applyFollowingDelta(nextFollowing ? 1 : -1);
    setFollowPending(true);

    void (async () => {
      const ok = await (nextFollowing ? followUser(targetUserId) : unfollowUser(targetUserId));
      if (!ok) {
        // Reconcile: the write failed, so undo the optimistic flip + both counts.
        setFollowState(wasFollowing ? 'following' : 'not-following');
        setDisplayFollowerCount((count) => count + (nextFollowing ? -1 : 1));
        auth.applyFollowingDelta(nextFollowing ? -1 : 1);
      }
      setFollowPending(false);
    })();
  }, [auth, followPending, followState, targetUserId]);

  // Open (or create) the 1:1 thread with this collector, then jump straight into
  // it. The display name rides along as `?name=` because the thread screen titles
  // its header from that param — there is no fetch-one-conversation read in the
  // data layer, so without it the header would be blank.
  const handleOpenMessage = useCallback(() => {
    if (!targetUserId || messagePendingRef.current) {
      return;
    }

    messagePendingRef.current = true;
    setMessagePending(true);
    setMessageFailed(false);

    void (async () => {
      const conversationId = await findOrCreateDm(targetUserId);
      messagePendingRef.current = false;
      setMessagePending(false);

      if (!conversationId) {
        // `findOrCreateDm` returns null for BOTH a failed write and a refused
        // self-DM. Either way there is no thread to open, and pushing anyway
        // would land on `/messages/null` — a route that renders nothing. Say so
        // in passing and leave the profile exactly as it was.
        setMessageFailed(true);
        return;
      }

      // `as never` is the same escape hatch `notifications-screen` uses:
      // expo-router's typed-route union lives in the gitignored, generated
      // `.expo/types/router.d.ts`, which only regenerates while the dev server
      // runs — so `/messages/[conversationId]`, added since the last generation,
      // isn't in the union and `tsc --noEmit` rejects it. Drop the cast once the
      // route map has been regenerated.
      router.push({
        pathname: '/messages/[conversationId]',
        params: { conversationId, name: getProfileDisplayName(profile) },
      } as never);
    })();
  }, [profile, router, targetUserId]);

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
    // Normalised here too, not only on save: profiles written before this
    // validation existed still hold raw text, and this is the call that would
    // silently no-op on it.
    const url = normalizeSocialLink(link);
    if (!url) {
      return;
    }
    void Linking.openURL(url).catch(() => {});
  }, [profile?.socialLink]);

  const handlePressEntry = useCallback(
    (entry: InventoryCardEntry) => {
      onOpenEntry?.(entry);
    },
    [onOpenEntry],
  );

  // Each page owns its own list now, so the two data sets are built
  // independently instead of one being selected by the active tab.
  const collectionData = useMemo<PublicCollectionRow[]>(() => {
    if (entries.length === 0) {
      return [];
    }
    if (entries.length === 1) {
      return [{ kind: 'grid-single', key: entries[0].id, entry: entries[0] }];
    }
    const rows = chunkCollectionGridRows(entries);
    return rows.map((rowEntries, rowIndex) => ({
      kind: 'grid',
      key: rowEntries[0]?.id ?? `grid-row-${rowIndex}`,
      rowEntries,
      rowIndex,
      isLastRow: rowIndex === rows.length - 1,
    }));
  }, [entries]);

  const wishlistData = useMemo<PublicCollectionRow[]>(() => {
    if (wishlistEntries.length === 0) {
      return [];
    }
    if (wishlistEntries.length === 1) {
      return [{ kind: 'grid-single', key: wishlistEntries[0].id, entry: wishlistEntries[0] }];
    }
    const rows = chunkCollectionGridRows(wishlistEntries);
    return rows.map((rowEntries, rowIndex) => ({
      kind: 'grid',
      key: rowEntries[0]?.id ?? `wishlist-row-${rowIndex}`,
      rowEntries,
      rowIndex,
      isLastRow: rowIndex === rows.length - 1,
    }));
  }, [wishlistEntries]);

  const activityData = useMemo<PublicCollectionRow[]>(
    () =>
      activityPosts.map((item) => ({
        kind: 'post',
        key: item.post.id,
        post: item.post,
        repostedAt: item.repostedAt,
      })),
    [activityPosts],
  );

  const handleOpenCard = useCallback(
    (cardId: string) => {
      router.push({ pathname: '/cards/[cardId]', params: { cardId } });
    },
    [router],
  );

  // Shared row renderer. The grid testID is a PARAMETER because the pager mounts
  // Collection and Wishlist at the same time — one shared root would emit two
  // tiles per card id.
  const renderRow = useCallback(
    (item: PublicCollectionRow, gridTestID: string) => {
      if (item.kind === 'post') {
        // Full-bleed post card (Figma 2903-7128): the card owns its inner padding
        // and its image spans edge-to-edge, so no page-gutter wrapper here.
        return (
          <>
            {/*
              A reposted card carries the ORIGINAL author's name and avatar, so
              without this line it reads as though this collector posted someone
              else's photo. It says whose act put the post here, not whose post
              it is.
            */}
            {item.repostedAt ? (
              <RepostAttribution
                name={viewerId && viewerId === targetUserId ? null : profile?.displayName}
                testID={`${testID}-repost-attribution`}
              />
            ) : null}
            <PostCard
              accessToken={accessToken}
              apiBaseUrl={apiBaseUrl}
              onPressCard={handleOpenCard}
              post={item.post}
              testID={`${testID}-post`}
            />
          </>
        );
      }
      if (item.kind === 'grid-single') {
        return (
          <CollectionGridSingleRow
            entry={item.entry}
            onPressEntry={handlePressEntry}
            testID={gridTestID}
          />
        );
      }
      return (
        <CollectionGridRow
          isLastRow={item.isLastRow}
          onPressEntry={handlePressEntry}
          rowEntries={item.rowEntries}
          rowIndex={item.rowIndex}
          testID={gridTestID}
        />
      );
    },
    [
      accessToken,
      apiBaseUrl,
      handleOpenCard,
      handlePressEntry,
      profile?.displayName,
      targetUserId,
      testID,
      viewerId,
    ],
  );

  const renderItem = useCallback(
    ({ item }: { item: PublicCollectionRow }) => renderRow(item, GRID_TEST_ID),
    [renderRow],
  );

  const renderWishlistItem = useCallback(
    ({ item }: { item: PublicCollectionRow }) => renderRow(item, WISHLIST_GRID_TEST_ID),
    [renderRow],
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

  // ── The PINNED chrome ──────────────────────────────────────────────────────
  // Profile block + follow/message row + tab bar are rendered ONCE, above all
  // three pages. The profile block still scrolls away (the pager translates it
  // up with the active page's offset); the tab bar stops at the top and pins.
  // Both need an opaque background — page content scrolls UNDER them.
  const pagerHeader = (
    <View style={[styles.chrome, { backgroundColor: theme.colors.gray0 }]}>
      <ProfileHeader
        avatarUrl={profile?.avatarURL}
        bio={profile?.bio}
        coverUrl={profile?.coverURL}
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
        // Figma 2730:4617. Two 32pt rounded buttons splitting the gutter width
        // (175.5pt each at 393pt) with a 10pt gap, uppercase 13pt labels.
        //
        // The emphasis is deliberately inverted from what you'd guess: MESSAGE
        // is the dark fill and FOLLOW is the white outline. On someone else's
        // profile the design treats starting a conversation as the primary act,
        // not following. FOLLOWING keeps the same outline shell so the row
        // doesn't reflow when the state flips — only the label changes.
        <View style={[styles.actionRow, { paddingHorizontal: theme.layout.pageGutter }]}>
          <Button
            disabled={followState === null}
            label={followState === 'following' ? 'FOLLOWING' : 'FOLLOW'}
            labelStyleVariant="label"
            onPress={handleToggleFollow}
            shape="rounded"
            size="xs"
            style={styles.actionButton}
            testID={`${testID}-follow-button`}
            variant="outline"
          />
          <Button
            disabled={messagePending}
            label="MESSAGE"
            labelStyleVariant="label"
            onPress={handleOpenMessage}
            shape="rounded"
            size="xs"
            style={styles.actionButton}
            testID={`${testID}-message-button`}
            variant="dark"
          />
        </View>
      ) : null}
    </View>
  );

  const pagerTabBar = (
    <View style={{ backgroundColor: theme.colors.gray0 }}>
      <PageTabs
        onChange={setActiveTab}
        tabs={PROFILE_TABS}
        testID={`${testID}-tabs`}
        value={activeTab}
      />
    </View>
  );

  // ── The Collection page's OWN header ───────────────────────────────────────
  // The portfolio headline used to be a sibling of the profile block in one
  // shared list header. It belongs to Collection only, so it moves into that
  // page and scrolls under the pinned tab bar.
  const collectionChrome = (
    <View style={styles.pageChrome}>
      {collectionStatus === 'error' ? (
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

  // Loading is a chromeless spinner; only the settled empty state earns a card.
  const activityEmpty =
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
    );

  const collectionEmpty =
    collectionStatus === 'error' ? null : collectionStatus === 'loading' ? (
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
    );

  const wishlistEmpty =
    wishlistStatus === 'loading' || wishlistStatus === 'idle' ? (
      <InlineLoader label="Fetching wishlist" testID={`${testID}-wishlist-empty`} />
    ) : (
      <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
        <StateCard
          message={
            wishlistStatus === 'error'
              ? 'Please try again in a moment.'
              : "This collector hasn't wishlisted any cards yet."
          }
          style={styles.stateCard}
          testID={`${testID}-wishlist-empty`}
          title={wishlistStatus === 'error' ? 'Could not load this wishlist' : 'No cards on their wishlist yet'}
          variant="field"
        />
      </View>
    );

  const wishlistFooter = wishlistLoadingMore ? (
    <View style={styles.footerSpinner}>
      <ActivityIndicator
        color={theme.colors.textSecondary}
        testID={`${testID}-wishlist-loading-more`}
      />
    </View>
  ) : null;

  const collectionFooter = isLoadingMore ? (
    <View style={styles.footerSpinner}>
      <ActivityIndicator
        color={theme.colors.textSecondary}
        testID={`${testID}-collection-loading-more`}
      />
    </View>
  ) : null;

  // One scroller per page tab, each with its own virtualization. `page` carries
  // the padding and the animated scroll handler the pager needs; pass
  // `page.onScroll` STRAIGHT through or it silently loses the native driver.
  const renderProfilePage = (tab: ProfileTab, page: CollapsiblePageProps) => {
    const contentContainerStyle = [
      page.contentContainerStyle,
      { paddingBottom: insets.bottom + 24 },
    ];

    if (tab === 'forsale') {
      return (
        <AnimatedScrollView
          ref={forSaleScrollRef}
          contentContainerStyle={contentContainerStyle}
          onScroll={page.onScroll}
          scrollEventThrottle={page.scrollEventThrottle}
          // RN clamps a NEGATIVE scrollTo target to 0 unless this is set
          // (RCTScrollViewComponentView.mm), and it clamps against
          // `contentInset` — which is empty here, because
          // `contentInsetAdjustmentBehavior="automatic"` puts the safe area
          // in `adjustedContentInset` instead. Without it every "go to the
          // top" the pager or the FAB performs lands `insets.top` short.
          // `handled` so the comment sheet below gets the FIRST tap while its
          // keyboard is up. Unset, a ScrollView claims that touch in the capture
          // phase to dismiss the keyboard, costing send/⋯/like/reply a tap each.
          keyboardShouldPersistTaps="handled"
          scrollToOverflowEnabled={page.scrollToOverflowEnabled}
          testID={`${testID}-forsale-page`}
        >
          <View style={{ paddingHorizontal: theme.layout.pageGutter }}>
            <StateCard
              message="For Sale is coming soon."
              style={styles.stateCard}
              title="Coming soon"
              variant="field"
            />
          </View>
        </AnimatedScrollView>
      );
    }

    if (tab === 'wishlist') {
      return (
        <AnimatedFlatList
          ref={wishlistScrollRef}
          contentContainerStyle={contentContainerStyle}
          data={wishlistData}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={wishlistEmpty}
          ListFooterComponent={wishlistFooter}
          onEndReached={handleLoadMoreWishlist}
          onEndReachedThreshold={0.5}
          onScroll={page.onScroll}
          renderItem={renderWishlistItem}
          scrollEventThrottle={page.scrollEventThrottle}
          // Same two scroll flags the sibling pages carry — see the Collection
          // page below for why each is load-bearing.
          keyboardShouldPersistTaps="handled"
          scrollToOverflowEnabled={page.scrollToOverflowEnabled}
          testID={`${testID}-wishlist-page`}
        />
      );
    }

    if (tab === 'activity') {
      return (
        <AnimatedFlatList
          ref={activityScrollRef}
          contentContainerStyle={contentContainerStyle}
          data={activityData}
          keyExtractor={(item) => item.key}
          ListEmptyComponent={activityEmpty}
          onScroll={page.onScroll}
          renderItem={renderItem}
          scrollEventThrottle={page.scrollEventThrottle}
          // RN clamps a NEGATIVE scrollTo target to 0 unless this is set
          // (RCTScrollViewComponentView.mm), and it clamps against
          // `contentInset` — which is empty here, because
          // `contentInsetAdjustmentBehavior="automatic"` puts the safe area
          // in `adjustedContentInset` instead. Without it every "go to the
          // top" the pager or the FAB performs lands `insets.top` short.
          // `handled` so the comment sheet below gets the FIRST tap while its
          // keyboard is up. Unset, a ScrollView claims that touch in the capture
          // phase to dismiss the keyboard, costing send/⋯/like/reply a tap each.
          keyboardShouldPersistTaps="handled"
          scrollToOverflowEnabled={page.scrollToOverflowEnabled}
          testID={`${testID}-activity-page`}
        />
      );
    }

    return (
      <AnimatedFlatList
        ref={collectionScrollRef}
        contentContainerStyle={contentContainerStyle}
        data={collectionData}
        keyExtractor={(item) => item.key}
        ListEmptyComponent={collectionEmpty}
        ListFooterComponent={collectionFooter}
        ListHeaderComponent={collectionChrome}
        onEndReached={handleLoadMoreEntries}
        onEndReachedThreshold={0.5}
        onScroll={page.onScroll}
        renderItem={renderItem}
        scrollEventThrottle={page.scrollEventThrottle}
          // RN clamps a NEGATIVE scrollTo target to 0 unless this is set
          // (RCTScrollViewComponentView.mm), and it clamps against
          // `contentInset` — which is empty here, because
          // `contentInsetAdjustmentBehavior="automatic"` puts the safe area
          // in `adjustedContentInset` instead. Without it every "go to the
          // top" the pager or the FAB performs lands `insets.top` short.
          // `handled` so the comment sheet below gets the FIRST tap while its
          // keyboard is up. Unset, a ScrollView claims that touch in the capture
          // phase to dismiss the keyboard, costing send/⋯/like/reply a tap each.
          keyboardShouldPersistTaps="handled"
          scrollToOverflowEnabled={page.scrollToOverflowEnabled}
        testID={`${testID}-scroll-view`}
      />
    );
  };

  return (
    <SafeAreaView
      edges={['left', 'right']}
      style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}
      testID={testID}
    >
      {/*
        Collapsing profile header, pinned tab bar, drag-following pages beneath —
        the same shape the owner's Portfolio has. There is no `DrawerEdgeSwipe`
        on this route, but the left-edge band is still spoken for: this is a
        PUSHED stack screen, so that band is the interactive back-swipe. The
        pager ignores it by default.
      */}
      <CollapsibleTabPager
        header={pagerHeader}
        onChange={setActiveTab}
        order={PROFILE_TAB_ORDER}
        pageRefs={pageScrollRefs}
        renderPage={renderProfilePage}
        tabBar={pagerTabBar}
        testID={`${testID}-page-tab-pager`}
        value={activeTab}
      />
      {backButton}
      {/*
        A DM that couldn't be opened is a one-off action failure, not a section
        that failed to load, so it gets the transient Toast rather than one of
        the inline StateCards above — the profile stays fully usable underneath
        and nothing has to be dismissed to keep browsing.
      */}
      <Toast
        message="Couldn't open that conversation. Please try again."
        onDismiss={() => setMessageFailed(false)}
        style={[
          styles.messageToast,
          {
            bottom: insets.bottom + theme.spacing.lg,
            left: theme.layout.pageGutter,
            right: theme.layout.pageGutter,
          },
        ]}
        testID={`${testID}-message-error`}
        tone="dark"
        visible={messageFailed}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    // 10, not a spacing token: the scale jumps 8 → 12 and Figma 2730:4617 is
    // explicit about 10 here, which is what lands each button on 175.5pt.
    gap: 10,
  },
  backButton: {
    position: 'absolute',
    zIndex: 5,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
  },
  chrome: {
    gap: 20,
    // No bottom padding: PageTabs below owns the 16pt above its labels
    // (Figma 4067:26806).
  },
  // The Collection page's own header, below the pinned tab bar. 24px down from
  // the bar, matching the owner Portfolio's tabs→balance gap.
  pageChrome: {
    paddingBottom: 16,
    paddingTop: 24,
  },
  footerSpinner: {
    paddingVertical: 20,
  },
  messageToast: {
    position: 'absolute',
    zIndex: 5,
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

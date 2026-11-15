import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import type { SpotlightEventMapVendor } from '@spotlight/api-client';
import { Button, radii, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { useGuestGate } from '@/features/auth/use-guest-gate';
import {
  claimBooth,
  fetchBrowsingNow,
  recordBoothEvent,
  reportBoothClaim,
  unclaimBooth,
  type BoothClaim,
  type BoothPost,
} from '@/features/events/booth-service';
import { followUser, isFollowing, unfollowUser } from '@/features/profile/profile-service';
import { PostImage, postMediaUrl } from '@/features/social/components/post-card';
import { findOrCreateDm } from '@/features/social/dm-service';
import { profileRouteSlug } from '@/features/social/profile-link';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

export const BOOTH_STATS_REFRESH_MS = 60_000;

/** "12 people at the show right now"; null while unknown. */
export function formatShowCrowd(count: number | null): string | null {
  if (count == null || count < 1) {
    return null;
  }
  return `${count} ${count === 1 ? 'person' : 'people'} at the show right now`;
}
const THUMB_WIDTH = 48;
const MAX_THUMBS = 10;

type BoothVendorPanelProps = {
  eventId: string;
  vendor: SpotlightEventMapVendor;
  claim: BoothClaim | null;
  myUserId: string | null;
  posts: readonly BoothPost[];
  onClaimsChanged: () => void;
};

/** The booth half of the vendor card: claim state, the owner's live crowd count, and the photo strip. */
export function BoothVendorPanel({ eventId, vendor, claim, myUserId, posts, onClaimsChanged }: BoothVendorPanelProps) {
  const mine = claim != null && myUserId != null && claim.userId === myUserId;
  return (
    <View style={styles.panel} testID="booth-panel">
      {claim == null ? (
        <UnclaimedRow eventId={eventId} onClaimsChanged={onClaimsChanged} vendor={vendor} />
      ) : mine ? (
        <MyBoothRows eventId={eventId} onClaimsChanged={onClaimsChanged} vendor={vendor} />
      ) : (
        <ClaimedRows claim={claim} eventId={eventId} vendor={vendor} />
      )}
      <BoothPhotoStrip eventId={eventId} posts={posts} vendorId={vendor.id} />
    </View>
  );
}

/**
 * One tap to claim, shared by the card and the list's claim pills. Resolves to
 * whether the booth is now the caller's; every outcome explains itself.
 */
export function useClaimBooth(eventId: string, onClaimsChanged: () => void) {
  const { gate, openLogin } = useGuestGate();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pending = useRef(false);

  const claim = useCallback(
    (vendor: Pick<SpotlightEventMapVendor, 'id' | 'name'>, source: 'card' | 'list' | 'suggestion') => {
      if (pending.current) {
        return;
      }
      pending.current = true;
      setPendingId(vendor.id);
      void claimBooth(vendor.id, eventId).then((result) => {
        pending.current = false;
        setPendingId(null);
        if (result === 'claimed' || result === 'already_yours') {
          if (result === 'claimed') {
            capturePostHogEvent(AnalyticsEvent.boothClaimed, { event_id: eventId, vendor_id: vendor.id, source });
            Alert.alert('Booth claimed', `${vendor.name} is yours. Post photos of your case so people find you.`);
          }
          onClaimsChanged();
        } else if (result === 'unauthenticated') {
          openLogin();
        } else if (result === 'taken') {
          Alert.alert('Already claimed', 'Someone else claimed this booth. Use "Not you? Report" if that’s wrong.');
          onClaimsChanged();
        } else if (result === 'limit') {
          Alert.alert('Booth limit reached', 'One account can claim up to 3 booths.');
        } else {
          Alert.alert('Couldn’t claim this booth', 'Please try again.');
        }
      });
    },
    [eventId, onClaimsChanged, openLogin],
  );

  return { claim, gate, pendingId };
}

/**
 * Opens (or creates) a DM with whoever holds a booth, counting a message start.
 * Shared by the vendor card and the story viewer; callers guest-gate it.
 */
export function useBoothMessage(eventId: string, vendor: Pick<SpotlightEventMapVendor, 'id' | 'name'>) {
  const router = useRouter();
  const pending = useRef(false);
  return useCallback(
    (userId: string, handle: string | null) => {
      if (pending.current) {
        return;
      }
      pending.current = true;
      recordBoothEvent(eventId, vendor.id, 'message_start');
      void findOrCreateDm(userId).then((conversationId) => {
        pending.current = false;
        if (!conversationId) {
          Alert.alert('Couldn’t open a message', 'Please try again.');
          return;
        }
        // Typed routes lag new routes; same cast as the profile screen.
        router.push({
          pathname: '/messages/[conversationId]',
          params: { conversationId, name: handle ? `@${handle}` : vendor.name },
        } as never);
      });
    },
    [eventId, router, vendor.id, vendor.name],
  );
}

/** The card's claim stays as a fallback; the list's "Claim" pill and "This is you" are the main path. */
function UnclaimedRow({
  eventId,
  vendor,
  onClaimsChanged,
}: {
  eventId: string;
  vendor: SpotlightEventMapVendor;
  onClaimsChanged: () => void;
}) {
  const { claim, gate, pendingId } = useClaimBooth(eventId, onClaimsChanged);
  return (
    <View style={styles.row}>
      <Button
        disabled={pendingId != null}
        label="This is my booth"
        labelStyleVariant="caption"
        onPress={gate(() => claim(vendor, 'card'))}
        shape="rounded"
        size="xs"
        testID="booth-claim"
        variant="ghost"
      />
    </View>
  );
}

function ClaimedRows({ claim, eventId, vendor }: { claim: BoothClaim; eventId: string; vendor: SpotlightEventMapVendor }) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { gate } = useGuestGate();
  const { applyFollowingDelta } = useAuth();
  const [following, setFollowing] = useState<boolean | null>(null);
  const slug = profileRouteSlug(claim.handle, claim.userId);
  const holderLabel = claim.handle ? `@${claim.handle}` : 'Claimed';

  useEffect(() => {
    let active = true;
    setFollowing(null);
    void isFollowing(claim.userId).then((value) => {
      if (active) {
        setFollowing(value);
      }
    });
    return () => {
      active = false;
    };
  }, [claim.userId]);

  const openProfile = useCallback(() => {
    if (slug) {
      router.push(`/u/${slug}` as never);
    }
  }, [router, slug]);

  const startMessage = useBoothMessage(eventId, vendor);
  const message = useCallback(() => startMessage(claim.userId, claim.handle), [claim.handle, claim.userId, startMessage]);

  const toggleFollow = useCallback(() => {
    if (following == null) {
      return;
    }
    const next = !following;
    // Optimistic, reverted on failure, as on profiles.
    setFollowing(next);
    applyFollowingDelta?.(next ? 1 : -1);
    void (next ? followUser(claim.userId) : unfollowUser(claim.userId)).then((ok) => {
      if (!ok) {
        setFollowing(!next);
        applyFollowingDelta?.(next ? -1 : 1);
      }
    });
  }, [applyFollowingDelta, claim.userId, following]);

  const report = useCallback(() => {
    void reportBoothClaim(vendor.id).then((ok) => {
      Alert.alert(
        ok ? 'Thanks for letting us know' : 'Couldn’t send the report',
        ok ? 'We’ll check who this booth belongs to.' : 'Please try again.',
      );
    });
  }, [vendor.id]);

  return (
    <>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="link"
          disabled={!slug}
          hitSlop={spacing.xxxs}
          onPress={openProfile}
          style={styles.grow}
          testID="booth-holder"
        >
          <Text numberOfLines={1} style={[theme.typography.label, { color: theme.colors.purple500 }]}>
            {holderLabel}
          </Text>
        </Pressable>
        <Button
          label="Message"
          labelStyleVariant="label"
          onPress={gate(message)}
          shape="rounded"
          size="xs"
          testID="booth-message"
          variant="primary"
        />
        <Button
          disabled={following == null}
          label={following ? 'Following' : 'Follow'}
          labelStyleVariant="label"
          onPress={gate(toggleFollow)}
          shape="rounded"
          size="xs"
          testID="booth-follow"
          variant="secondary"
        />
      </View>
      <Pressable accessibilityRole="button" hitSlop={spacing.xxxs} onPress={gate(report)} testID="booth-report">
        <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>Not you? Report</Text>
      </Pressable>
    </>
  );
}

function MyBoothRows({
  eventId,
  vendor,
  onClaimsChanged,
}: {
  eventId: string;
  vendor: SpotlightEventMapVendor;
  onClaimsChanged: () => void;
}) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const [browsingNow, setBrowsingNow] = useState<number | null>(null);

  // Who's on the show right now (the page's own heartbeat feeds it), refreshed every minute while the card is open.
  useEffect(() => {
    let active = true;
    const load = () =>
      void fetchBrowsingNow(eventId).then((next) => {
        if (active) {
          setBrowsingNow(next);
        }
      });
    load();
    capturePostHogEvent(AnalyticsEvent.boothStatsViewed, { event_id: eventId, vendor_id: vendor.id });
    const timer = setInterval(load, BOOTH_STATS_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [eventId, vendor.id]);

  const post = useCallback(() => {
    router.push(
      `/new-post?eventId=${encodeURIComponent(eventId)}&vendorId=${encodeURIComponent(vendor.id)}` as never,
    );
  }, [eventId, router, vendor.id]);

  const unclaim = useCallback(() => {
    Alert.alert('Unclaim this booth?', `${vendor.name} will no longer be linked to your account.`, [
      { style: 'cancel', text: 'Cancel' },
      {
        style: 'destructive',
        text: 'Unclaim',
        onPress: () => {
          void unclaimBooth(vendor.id).then((ok) => {
            if (ok) {
              onClaimsChanged();
            } else {
              Alert.alert('Couldn’t unclaim', 'Please try again.');
            }
          });
        },
      },
    ]);
  }, [onClaimsChanged, vendor.id, vendor.name]);

  return (
    <>
      <View style={styles.row}>
        <Text style={[theme.typography.label, styles.grow, { color: theme.colors.gray900 }]} testID="booth-mine">
          Your booth
        </Text>
        <Button
          label="Post to your booth"
          labelStyleVariant="label"
          onPress={post}
          shape="rounded"
          size="xs"
          testID="booth-post"
          variant="primary"
        />
      </View>
      <View style={styles.row}>
        <Text
          numberOfLines={1}
          style={[theme.typography.caption, styles.grow, { color: theme.colors.gray600 }]}
          testID="booth-stats"
        >
          {formatShowCrowd(browsingNow) ?? ' '}
        </Text>
        <Pressable accessibilityRole="button" hitSlop={spacing.xxxs} onPress={unclaim} testID="booth-unclaim">
          <Text style={[theme.typography.caption, { color: theme.colors.gray600 }]}>Unclaim</Text>
        </Pressable>
      </View>
    </>
  );
}

/** Thumbnails of this vendor's booth posts; tap opens the post. */
function BoothPhotoStrip({ eventId, posts, vendorId }: { eventId: string; posts: readonly BoothPost[]; vendorId: string }) {
  const router = useRouter();
  const { accessToken, currentUser } = useAuth();
  const apiBaseUrl = resolveRepositoryBaseUrl();
  const withPhotos = posts.filter((post) => post.media.length > 0).slice(0, MAX_THUMBS);
  // Post images are private until approved and only stream with a bearer token.
  if (!apiBaseUrl || !accessToken || withPhotos.length === 0) {
    return null;
  }
  return (
    <ScrollView
      contentContainerStyle={styles.strip}
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="booth-strip"
    >
      {withPhotos.map((post) => {
        const media = post.media[0];
        return (
          <Pressable
            accessibilityLabel="Open booth post"
            accessibilityRole="button"
            key={post.id}
            onPress={() => {
              recordBoothEvent(eventId, vendorId, 'post_view');
              router.push(`/post/${post.id}` as never);
            }}
            style={styles.thumb}
            testID={`booth-strip-${post.id}`}
          >
            <PostImage
              accessToken={accessToken}
              compact
              media={media}
              style={styles.thumbImage}
              uri={postMediaUrl(apiBaseUrl, media.id, { displayWidth: THUMB_WIDTH })}
              viewerIsAuthor={currentUser?.id === post.authorId}
            />
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: spacing.xxs,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  grow: {
    flex: 1,
  },
  strip: {
    gap: spacing.xxs,
  },
  thumb: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    overflow: 'hidden',
    width: THUMB_WIDTH,
  },
  thumbImage: {
    width: THUMB_WIDTH,
  },
});

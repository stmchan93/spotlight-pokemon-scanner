import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import type { SpotlightEventMapVendor } from '@spotlight/api-client';
import { Button, radii, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { useGuestGate } from '@/features/auth/use-guest-gate';
import { formatBoothStats } from '@/features/events/booth-format';
import {
  claimBooth,
  fetchBoothStats,
  recordBoothEvent,
  reportBoothClaim,
  unclaimBooth,
  type BoothClaim,
  type BoothPost,
  type BoothStats,
} from '@/features/events/booth-service';
import { followUser, isFollowing, unfollowUser } from '@/features/profile/profile-service';
import { PostImage } from '@/features/social/components/post-card';
import { findOrCreateDm } from '@/features/social/dm-service';
import { profileRouteSlug } from '@/features/social/profile-link';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

export const BOOTH_STATS_REFRESH_MS = 60_000;
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

/** The booth half of the vendor card: claim state, the owner's stats, and the photo strip. */
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

function UnclaimedRow({
  eventId,
  vendor,
  onClaimsChanged,
}: {
  eventId: string;
  vendor: SpotlightEventMapVendor;
  onClaimsChanged: () => void;
}) {
  const { gate, openLogin } = useGuestGate();
  const [pending, setPending] = useState(false);

  const claim = useCallback(() => {
    if (pending) {
      return;
    }
    setPending(true);
    void claimBooth(vendor.id, eventId).then((result) => {
      setPending(false);
      if (result === 'claimed' || result === 'already_yours') {
        if (result === 'claimed') {
          capturePostHogEvent(AnalyticsEvent.boothClaimed, { event_id: eventId, vendor_id: vendor.id });
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
  }, [eventId, onClaimsChanged, openLogin, pending, vendor.id, vendor.name]);

  return (
    <View style={styles.row}>
      <Button
        disabled={pending}
        label="This is my booth"
        labelStyleVariant="label"
        onPress={gate(claim)}
        shape="rounded"
        size="xs"
        testID="booth-claim"
        variant="secondary"
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
  const messagePending = useRef(false);
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

  const message = useCallback(() => {
    if (messagePending.current) {
      return;
    }
    messagePending.current = true;
    recordBoothEvent(eventId, vendor.id, 'message_start');
    void findOrCreateDm(claim.userId).then((conversationId) => {
      messagePending.current = false;
      if (!conversationId) {
        Alert.alert('Couldn’t open a message', 'Please try again.');
        return;
      }
      // Typed routes lag new routes; same cast as the profile screen.
      router.push({
        pathname: '/messages/[conversationId]',
        params: { conversationId, name: claim.handle ? `@${claim.handle}` : vendor.name },
      } as never);
    });
  }, [claim.handle, claim.userId, eventId, router, vendor.id, vendor.name]);

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
  const [stats, setStats] = useState<BoothStats | null>(null);

  // Refreshed every minute while the card is open.
  useEffect(() => {
    let active = true;
    const load = () =>
      void fetchBoothStats(vendor.id, eventId).then((next) => {
        if (active) {
          setStats(next);
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
          {stats ? `Your booth: ${formatBoothStats(stats)}` : ' '}
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
  const base = apiBaseUrl.replace(/\/+$/, '');
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
              media={media}
              style={styles.thumbImage}
              uri={`${base}/api/v1/post-media/${media.id}`}
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

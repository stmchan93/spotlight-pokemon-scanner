import { Image } from 'expo-image';
import { CheckCircle, Link } from 'iconoir-react-native';
import { useCallback, useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, SkeletonBlock, Text, useSpotlightTheme } from '@spotlight/design-system';

type ProfileHeaderProps = {
  displayName: string;
  handle?: string | null;
  initials: string;
  isVerified?: boolean;
  bio?: string | null;
  socialLink?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  /**
   * On-device URI for a cover the user just picked (the resized JPEG that was
   * uploaded). The remote `coverUrl` is a cold GCS fetch that takes seconds on
   * first paint, but these exact bytes are already on disk — handing them over
   * lets the banner paint immediately and cross-fade to the remote copy once it
   * is cached, instead of showing a skeleton for something the device has.
   * Omit it (the normal case, e.g. viewing someone else's profile) and the
   * skeleton covers the wait.
   */
  coverPreviewUri?: string | null;
  followerCount?: number;
  followingCount?: number;
  reputation?: number;
  onSocialLinkPress?: () => void;
  onFollowersPress?: () => void;
  onFollowingPress?: () => void;
  /*
   * NO EDIT CONTROL HERE. This block carried an owner-only pencil beside the
   * display name, on the argument that the top bar (then Figma 3505:14521) had
   * four slots and none of them was edit. The profile toolbar has since been
   * redrawn — 3670:47454 gives its trailing capsule an edit pencil and a share
   * glyph — so edit lives in the bar again, and a second pencil 100pt below it
   * would be two controls for one action.
   *
   * The screen that owns the bar owns the affordance: `portfolio-screen` passes
   * `onEditProfile` to `HomeHeader`, and the public profile (which draws this
   * same block for someone else) simply never renders one.
   */
  /**
   * Distance from the top of the header block to the top of the avatar. Screens
   * pass this so the avatar keeps a fixed gap below the floating nav bubbles,
   * whose position depends on the device's top safe-area inset. Omit to keep the
   * default overlap onto the bottom of the cover.
   */
  avatarTop?: number;
  testID?: string;
};

// Banner is 176px tall (Figma 2749:4707); the avatar straddles its bottom edge —
// half over the banner, half below ("half way up the photo banner").
const COVER_HEIGHT = 176;
const AVATAR_SIZE = 84;
const AVATAR_OVERLAP = -AVATAR_SIZE / 2;

/**
 * Cross-fade for the cover once the bytes are decoded. Short on purpose: long
 * enough to read as "arriving", short enough that it never feels like more
 * waiting on top of the download.
 */
const COVER_TRANSITION_MS = 180;

export function ProfileHeader({
  displayName,
  handle,
  initials,
  isVerified = false,
  bio,
  socialLink,
  avatarUrl,
  coverUrl,
  coverPreviewUri,
  followerCount,
  followingCount,
  reputation,
  onSocialLinkPress,
  onFollowersPress,
  onFollowingPress,
  avatarTop,
  testID = 'profile-header',
}: ProfileHeaderProps) {
  const theme = useSpotlightTheme();

  const insets = useSafeAreaInsets();
  // Which cover URL has finished loading (or failed). Storing the URL rather
  // than a boolean means a newly uploaded cover re-enters the loading state on
  // its own, with no reset effect and no one-frame flash of the loaded photo.
  const [settledCoverUrl, setSettledCoverUrl] = useState<string | null>(null);

  const handleCoverSettled = useCallback(() => {
    setSettledCoverUrl(coverUrl ?? null);
  }, [coverUrl]);

  const hasPreview = typeof coverPreviewUri === 'string' && coverPreviewUri.length > 0;
  // The skeleton is only for a wait the user cannot see through. With a local
  // preview the banner already shows the right picture, so a skeleton over it
  // would be a downgrade.
  const isCoverLoading = Boolean(coverUrl) && !hasPreview && settledCoverUrl !== coverUrl;

  return (
    <View style={styles.block} testID={testID}>
      {coverUrl ? (
        // The band keeps its own light-neutral fill behind the photo so the
        // slot is never transparent mid-load and never changes height when the
        // bytes land — the image fills the frame absolutely.
        <View
          style={[
            styles.cover,
            {
              backgroundColor: theme.colors.gray100,
              // Bleed under the status bar. The list this sits in uses
              // `contentInsetAdjustmentBehavior="automatic"`, which insets the
              // scroll content by the safe area — so without pulling back up by
              // exactly that amount the banner starts below the notch and leaves
              // a white strip above it. Height grows by the same amount, so the
              // visible band below the status bar is unchanged.
              height: COVER_HEIGHT + insets.top,
              marginTop: -insets.top,
            },
          ]}
          testID={`${testID}-cover-frame`}
        >
          <Image
            accessibilityIgnoresInvertColors
            // Covers are re-read on every visit to Portfolio and to the public
            // profile; memory-disk keeps a warm launch instant and a cold one
            // network-free after the first fetch.
            cachePolicy="memory-disk"
            contentFit="cover"
            onError={handleCoverSettled}
            onLoad={handleCoverSettled}
            // The just-picked JPEG is already on disk, so it paints on the
            // first frame while the identical remote copy is fetched.
            placeholder={hasPreview ? { uri: coverPreviewUri as string } : undefined}
            placeholderContentFit="cover"
            priority="high"
            recyclingKey={coverUrl}
            source={{ uri: coverUrl }}
            style={StyleSheet.absoluteFill}
            testID={`${testID}-cover`}
            transition={COVER_TRANSITION_MS}
          />
          {isCoverLoading ? (
            <CoverSkeleton testID={`${testID}-cover-skeleton`} />
          ) : null}
        </View>
      ) : (
        <View
          // A very light neutral, not the tinted `surfaceMuted` and not black —
          // the glass nav bubbles float over this band, and a dark backdrop
          // makes their refraction read as smudges.
          style={[
            styles.cover,
            {
              backgroundColor: theme.colors.gray100,
              // Bleeds under the status bar exactly like the photo branch. It
              // did not, which left a white strip above the grey band for every
              // profile WITHOUT a cover — and, because the band then started
              // insets.top lower, pushed the avatar and everything under it down
              // by the same amount. One missing pair of lines, two symptoms.
              height: COVER_HEIGHT + insets.top,
              marginTop: -insets.top,
            },
          ]}
          testID={`${testID}-cover-placeholder`}
        />
      )}

      <View style={[styles.body, { paddingHorizontal: theme.layout.pageGutter }]}>
        <Avatar
          initials={initials}
          ring
          size={AVATAR_SIZE}
          style={
            avatarTop === undefined
              ? styles.avatar
              : { marginTop: avatarTop - COVER_HEIGHT }
          }
          testID={`${testID}-avatar`}
          uri={avatarUrl}
        />

        <View style={styles.identityRow}>
          <View style={styles.identity}>
            <View style={styles.nameRow}>
              <Text
                style={[theme.typography.titleMedium, { lineHeight: 22 }]}
                testID={`${testID}-name`}
              >
                {displayName}
              </Text>
              {isVerified ? (
                <View style={styles.verifiedRow} testID={`${testID}-verified`}>
                  <CheckCircle color={theme.colors.purple500} height={14} width={14} />
                  <Text
                    style={[theme.typography.captionMedium, { color: theme.colors.purple500 }]}
                  >
                    Verified
                  </Text>
                </View>
              ) : null}
            </View>

            {handle ? (
              <Text
                style={[theme.typography.captionMedium, { color: theme.colors.gray500 }]}
                testID={`${testID}-handle`}
              >
                @{handle}
              </Text>
            ) : null}
          </View>

        </View>

        {socialLink ? (
          <Pressable
            onPress={onSocialLinkPress}
            style={styles.socialRow}
            testID={`${testID}-social-link`}
          >
            {/* Link is blue (#1A6FE8 / blue400) at 13px Medium — Figma 3083:12352.
                Sits directly under the name, above the bio. */}
            <Link color={theme.colors.blue400} height={16} width={16} />
            <Text
              style={[
                theme.typography.bodyMedium,
                { fontSize: 13, lineHeight: 16, color: theme.colors.blue400 },
              ]}
            >
              {socialLink}
            </Text>
          </Pressable>
        ) : null}

        {bio ? (
          <Text
            numberOfLines={3}
            // Bio is regular 13 / gray-700 (Figma 2749:4738).
            style={[theme.typography.body, { fontSize: 13, lineHeight: 18, color: theme.colors.gray700 }]}
            testID={`${testID}-bio`}
          >
            {bio}
          </Text>
        ) : null}

        <View style={styles.statsRow}>
          <StatChip
            count={followerCount ?? 0}
            label="Followers"
            onPress={onFollowersPress}
            testID={`${testID}-followers`}
          />
          <StatChip
            count={followingCount ?? 0}
            label="Following"
            onPress={onFollowingPress}
            testID={`${testID}-following`}
          />
          <StatChip
            count={reputation ?? 0}
            // User-facing name is "Fame"; the `reputation` column and props keep
            // their name, same as Wishlist/favorite.
            label="Fame"
            testID={`${testID}-reputation`}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Loading affordance for the cover banner. Fills the whole 176pt band with the
 * shared `SkeletonBlock` fill and pulses it, so a cover that is still
 * downloading reads as "arriving" instead of as the flat gray band a
 * cover-less profile shows. Same reduce-motion-gated pulse as
 * `CardPriceTrendSkeleton`, which is the app's existing skeleton idiom.
 */
function CoverSkeleton({ testID }: { testID?: string }) {
  const theme = useSpotlightTheme();

  // null = not yet resolved; gate the pulse on a known preference.
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const pulse = useSharedValue(1);

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (!cancelled) {
          setReduceMotion(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setReduceMotion(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (reduceMotion !== false) {
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withTiming(0.45, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse, reduceMotion]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, pulseStyle]}
      testID={testID}
    >
      <SkeletonBlock
        // Square corners and a slightly deeper gray than the band's own
        // gray100 fill, so the pulse is visible against it.
        height={COVER_HEIGHT}
        radius={0}
        style={{ backgroundColor: theme.colors.gray200 }}
        width="100%"
      />
    </Animated.View>
  );
}

function StatChip({
  count,
  label,
  onPress,
  testID,
}: {
  count: number;
  label: string;
  onPress?: () => void;
  testID?: string;
}) {
  const theme = useSpotlightTheme();

  const content = (
    <View
      style={[
        styles.chip,
        {
          // Flat gray-50 pill, radius-8 (Figma 3184-17324/28/32) — not the
          // purple-tinted surfaceMuted.
          backgroundColor: theme.colors.gray50,
          borderRadius: theme.radii.sm,
        },
      ]}
    >
      {/* Number bold 14, label regular 14 gray-600 (Figma 3184:17324/3095:5981). */}
      <Text
        style={[theme.typography.titleLarge, { fontSize: 14, lineHeight: 18, color: theme.colors.gray900 }]}
      >
        {count}
      </Text>
      <Text
        style={[theme.typography.body, { fontSize: 14, lineHeight: 18, color: theme.colors.gray600 }]}
      >
        {label}
      </Text>
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} style={styles.chipPressable} testID={testID}>
        {content}
      </Pressable>
    );
  }

  return (
    <View style={styles.chipPressable} testID={testID}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    marginTop: AVATAR_OVERLAP,
  },
  block: {
    width: '100%',
  },
  body: {
    // Figma 3083:12127 — tight vertical rhythm (name / link / bio / chips).
    gap: 6,
  },
  chip: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipPressable: {
    // Each pill takes an equal third of the row (Figma: flex-1 containers).
    flex: 1,
  },
  cover: {
    height: COVER_HEIGHT,
    width: '100%',
  },
  identity: {
    flex: 1,
    gap: 2,
  },
  identityRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  // The display name and, if there is one, the verified badge beside it. This
  // used to be two nested rows — name + badge in one, an edit pencil 16pt away
  // in the other — which collapsed to a single row when edit moved up into the
  // top bar (Figma 3670:47454).
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  socialRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  verifiedRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 2,
  },
});

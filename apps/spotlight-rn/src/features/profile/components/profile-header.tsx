import { Image } from 'expo-image';
import { CheckCircle, Link } from 'iconoir-react-native';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { Avatar, Text, useSpotlightTheme } from '@spotlight/design-system';

import { normalizeSocialLink } from '@/features/profile/social-link';

type ProfileHeaderProps = {
  displayName: string;
  handle?: string | null;
  initials: string;
  isVerified?: boolean;
  /**
   * Optional row rendered INSIDE the cover overlay, directly under the bio —
   * the public profile's FOLLOW / MESSAGE pair (Figma 4157:74954). Own-profile
   * callers omit it.
   */
  actionRow?: ReactNode;
  bio?: string | null;
  socialLink?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  /**
   * On-device URI for a cover the user just picked (the resized JPEG that was
   * uploaded). The remote `coverUrl` is a cold GCS fetch that takes seconds on
   * first paint, but these exact bytes are already on disk — handing them over
   * lets the banner paint immediately and cross-fade to the remote copy once it
   * is cached. Omit it (the normal case) and the skeleton covers the wait.
   */
  coverPreviewUri?: string | null;
  followerCount?: number;
  followingCount?: number;
  reputation?: number;
  onSocialLinkPress?: () => void;
  onFollowersPress?: () => void;
  onFollowingPress?: () => void;
  /**
   * Distance from the header's visible top (below the status bar) to the top of
   * the avatar. Screens pass this so the avatar keeps a fixed gap below the
   * floating nav bubbles. Defaults to the Figma resting position.
   */
  avatarTop?: number;
  testID?: string;
};

// Overlay header (Figma 4134:48866): all profile content renders over the
// full-bleed cover. Geometry is the frame's, measured below the status bar.
const CONTENT_HEIGHT = 286;
const DEFAULT_AVATAR_TOP = 66;
const AVATAR_SIZE = 80;
/**
 * The lip IS the 16pt gap Figma 4157:74399 draws between the sheet's top edge
 * and the tab labels — `PageTabs` adds no padding of its own on these screens.
 * The old 22 stacked with the bar's former 16 into ~38 of dead white above
 * "Collection". 16 also lets the 16pt corner radius span the full lip.
 */
const SHEET_LIP_HEIGHT = 16;

const COVER_TRANSITION_MS = 180;

export function ProfileHeader({
  displayName,
  handle,
  initials,
  isVerified = false,
  actionRow,
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
  avatarTop = DEFAULT_AVATAR_TOP,
  testID = 'profile-header',
}: ProfileHeaderProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  const [settledCoverUrl, setSettledCoverUrl] = useState<string | null>(null);

  const handleCoverSettled = useCallback(() => {
    setSettledCoverUrl(coverUrl ?? null);
  }, [coverUrl]);

  const hasPreview = typeof coverPreviewUri === 'string' && coverPreviewUri.length > 0;
  const isCoverLoading = Boolean(coverUrl) && !hasPreview && settledCoverUrl !== coverUrl;
  const isSocialLinkOpenable = normalizeSocialLink(socialLink) !== null;

  return (
    <View
      style={[
        styles.block,
        {
          height: CONTENT_HEIGHT + insets.top,
          // White text needs a dark ground even before the photo decodes (or
          // when the profile has no cover at all).
          backgroundColor: theme.colors.gray800,
        },
      ]}
      testID={testID}
    >
      {coverUrl ? (
        <>
          <Image
            accessibilityIgnoresInvertColors
            cachePolicy="memory-disk"
            contentFit="cover"
            onError={handleCoverSettled}
            onLoad={handleCoverSettled}
            placeholder={hasPreview ? { uri: coverPreviewUri as string } : undefined}
            placeholderContentFit="cover"
            priority="high"
            recyclingKey={coverUrl}
            source={{ uri: coverUrl }}
            style={StyleSheet.absoluteFill}
            testID={`${testID}-cover`}
            transition={COVER_TRANSITION_MS}
          />
          {isCoverLoading ? <CoverSkeleton testID={`${testID}-cover-skeleton`} /> : null}
        </>
      ) : (
        <View style={StyleSheet.absoluteFill} testID={`${testID}-cover-placeholder`} />
      )}

      <Svg pointerEvents="none" style={StyleSheet.absoluteFill} testID={`${testID}-scrim`}>
        <Defs>
          <LinearGradient id="profileScrim" x1="0" x2="0" y1="0" y2="1">
            {/* Figma 4134:49492 "Header Overlay": clear at the top, black 50%
                at the bottom — the pucks carry status-bar contrast, the sheet
                edge gets the weight. */}
            <Stop offset="0" stopColor="#666666" stopOpacity="0" />
            <Stop offset="0.3" stopColor="#414141" stopOpacity="0.25" />
            <Stop offset="1" stopColor="#000000" stopOpacity="0.5" />
          </LinearGradient>
        </Defs>
        <Rect fill="url(#profileScrim)" height="100%" width="100%" />
      </Svg>

      <View
        style={[
          styles.content,
          { paddingHorizontal: theme.layout.pageGutter, paddingTop: insets.top + avatarTop },
        ]}
      >
        <View style={styles.identityRow}>
          {/* No ring: the white border read as a sticker over the cover photo. */}
          <Avatar
            initials={initials}
            size={AVATAR_SIZE}
            testID={`${testID}-avatar`}
            uri={avatarUrl}
          />
          <View style={styles.identity}>
            <View style={styles.nameRow}>
              <Text
                numberOfLines={1}
                style={[theme.typography.titleMedium, { color: theme.colors.gray0 }]}
                testID={`${testID}-name`}
              >
                {displayName}
              </Text>
              {isVerified ? (
                <CheckCircle
                  color={theme.colors.purple500}
                  height={20}
                  testID={`${testID}-verified`}
                  width={20}
                />
              ) : null}
            </View>

            {handle ? (
              <Text
                style={[theme.typography.label, { color: theme.colors.gray200 }]}
                testID={`${testID}-handle`}
              >
                @{handle}
              </Text>
            ) : null}

            {socialLink ? (
              isSocialLinkOpenable ? (
                <Pressable
                  onPress={onSocialLinkPress}
                  style={styles.socialRow}
                  testID={`${testID}-social-link`}
                >
                  <Link color={theme.colors.linkOnDark} height={16} width={16} />
                  <Text
                    numberOfLines={1}
                    style={[theme.typography.label, { color: theme.colors.linkOnDark }]}
                  >
                    {socialLink}
                  </Text>
                </Pressable>
              ) : (
                <View style={styles.socialRow} testID={`${testID}-social-text`}>
                  <Text
                    numberOfLines={1}
                    style={[theme.typography.label, { color: theme.colors.gray300 }]}
                  >
                    {socialLink}
                  </Text>
                </View>
              )
            ) : null}
          </View>
        </View>

        <View style={styles.statsRow}>
          <StatText
            count={followerCount ?? 0}
            label="Followers"
            onPress={onFollowersPress}
            testID={`${testID}-followers`}
          />
          <StatText
            count={followingCount ?? 0}
            label="Following"
            onPress={onFollowingPress}
            testID={`${testID}-following`}
          />
          <StatText count={reputation ?? 0} label="Fame" testID={`${testID}-reputation`} />
        </View>

        {bio ? (
          <Text
            numberOfLines={2}
            style={[theme.typography.label, styles.bio, { color: theme.colors.gray0 }]}
            testID={`${testID}-bio`}
          >
            {bio}
          </Text>
        ) : null}
        {actionRow ? <View style={styles.actionRowSlot}>{actionRow}</View> : null}
      </View>

      {/*
        The white sheet lip that used to render here moved onto the tab-bar
        wrapper in both consumer screens: they pull the bar's rounded, opaque
        16pt top band up over this block's bottom edge, and a lip under it was
        invisible dead paint. `SHEET_LIP_HEIGHT` survives as the overlap the
        action row's bottom margin must clear.
      */}
    </View>
  );
}

function CoverSkeleton({ testID }: { testID?: string }) {
  const theme = useSpotlightTheme();

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
      style={[StyleSheet.absoluteFill, pulseStyle, { backgroundColor: theme.colors.gray700 }]}
      testID={testID}
    />
  );
}

function StatText({
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
    <View style={styles.statItem}>
      <Text
        style={[theme.typography.headline, styles.statCount, { color: theme.colors.gray0 }]}
      >
        {count}
      </Text>
      <Text style={[theme.typography.bodySmall, styles.statLabel, { color: theme.colors.gray0 }]}>
        {label}
      </Text>
    </View>
  );

  if (onPress) {
    return (
      <Pressable onPress={onPress} testID={testID}>
        {content}
      </Pressable>
    );
  }

  return <View testID={testID}>{content}</View>;
}

const styles = StyleSheet.create({
  actionRowSlot: {
    // 20 above AND below the Follow/Message row (Figma 4157:74906). The
    // VISIBLE gap below is measured to the white sheet's top edge — and the
    // 22pt sheet lip is drawn absolutely OVER the block's last 22pt, so the
    // margin must clear the lip first or the sheet swallows the buttons.
    marginBottom: SHEET_LIP_HEIGHT + 20,
    marginTop: 20,
  },
  bio: {
    marginTop: 8,
  },
  block: {
    overflow: 'hidden',
    width: '100%',
  },
  content: {
    ...StyleSheet.absoluteFillObject,
  },
  identity: {
    flex: 1,
    gap: 4,
  },
  identityRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  socialRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  statCount: {
    fontSize: 16,
    lineHeight: 20.2,
  },
  statItem: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  statLabel: {
    fontSize: 14,
    lineHeight: 17.6,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 12,
  },
});

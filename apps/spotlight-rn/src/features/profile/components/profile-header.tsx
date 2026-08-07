import { Image } from 'expo-image';
import { CheckCircle, Link } from 'iconoir-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { Avatar, Text, useSpotlightTheme } from '@spotlight/design-system';

type ProfileHeaderProps = {
  displayName: string;
  handle?: string | null;
  initials: string;
  isVerified?: boolean;
  bio?: string | null;
  socialLink?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  followerCount?: number;
  followingCount?: number;
  reputation?: number;
  onSocialLinkPress?: () => void;
  onFollowersPress?: () => void;
  onFollowingPress?: () => void;
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

export function ProfileHeader({
  displayName,
  handle,
  initials,
  isVerified = false,
  bio,
  socialLink,
  avatarUrl,
  coverUrl,
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

  return (
    <View style={styles.block} testID={testID}>
      {coverUrl ? (
        <Image
          contentFit="cover"
          source={{ uri: coverUrl }}
          style={styles.cover}
          testID={`${testID}-cover`}
        />
      ) : (
        <View
          // A very light neutral, not the tinted `surfaceMuted` and not black —
          // the glass nav bubbles float over this band, and a dark backdrop
          // makes their refraction read as smudges.
          style={[styles.cover, { backgroundColor: theme.colors.gray100 }]}
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
    gap: 2,
  },
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

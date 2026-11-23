import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { InventoryCardEntry } from '@spotlight/api-client';
import {
  Avatar,
  InventoryCardTile,
  SkeletonBlock,
  Text,
  layout,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import type { UserProfile } from '@/features/auth/auth-models';
import { formatOptionalCurrency } from '@/features/portfolio/components/portfolio-formatting';
import type { TopHoldingsState } from '@/features/profile/hooks/use-profiles-top-holdings';
import { VerifiedSeal } from '@/features/profile/components/verified-seal';
import { getProfileDisplayName, getProfileInitials } from '@/features/profile/screens/public-profile-screen';
import { getCardImageUrl } from '@/lib/card-images';

// Figma 6642:15541: a 194.5-wide holding tile; the rail runs off the right edge.
const HOLDING_TILE_WIDTH = 194.5;
// Figma 6642:14447: 42pt avatar.
const AVATAR_SIZE = 42;
const SKELETON_TILE_HEIGHT = 272;

type PersonSearchCardProps = {
  profile: UserProfile;
  /** Their most valuable holdings; absent / unavailable hides the rail. */
  holdings?: TopHoldingsState;
  onPressProfile: (profile: UserProfile) => void;
  onPressHolding: (profile: UserProfile, entry: InventoryCardEntry) => void;
  testID: string;
};

/** "2 FOLLOWERS", "1.2K FAME" — counts as the profile header shows them, in capitals. */
function statLabel(count: number | undefined, label: string): string {
  const value = Math.max(0, Math.floor(count ?? 0));
  return `${value.toLocaleString('en-US')} ${label}`;
}

/**
 * One person in Search's PEOPLE tab (Figma 6642:14444): avatar, name + verified
 * seal, "N FOLLOWERS · N FOLLOWING · N FAME", bio, and a rail of their most
 * valuable cards — each tile's box count is how many copies THEY own. The
 * header and bio open the profile; a tile opens the card from their profile.
 */
export const PersonSearchCard = memo(function PersonSearchCard({
  profile,
  holdings,
  onPressProfile,
  onPressHolding,
  testID,
}: PersonSearchCardProps) {
  const theme = useSpotlightTheme();
  const bio = profile.bio?.trim();
  const entries = holdings?.status === 'ready' ? holdings.entries : [];

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.gray0 }]} testID={testID}>
      <Pressable
        accessibilityLabel={getProfileDisplayName(profile)}
        accessibilityRole="button"
        onPress={() => onPressProfile(profile)}
        style={({ pressed }) => [styles.identity, { opacity: pressed ? 0.7 : 1 }]}
        testID={`${testID}-identity`}
      >
        <View style={styles.headerRow}>
          <Avatar
            initials={getProfileInitials(profile.displayName)}
            size={AVATAR_SIZE}
            testID={`${testID}-avatar`}
            uri={profile.avatarURL}
          />
          <View style={styles.headerCopy}>
            <View style={styles.nameRow}>
              <Text
                numberOfLines={1}
                style={[theme.typography.bodyMedium, styles.name, { color: theme.colors.gray900 }]}
                testID={`${testID}-name`}
              >
                {getProfileDisplayName(profile)}
              </Text>
              {profile.isVerified ? <VerifiedSeal size={16} testID={`${testID}-verified`} /> : null}
            </View>
            <View style={styles.stats}>
              {[
                statLabel(profile.followerCount, 'FOLLOWERS'),
                statLabel(profile.followingCount, 'FOLLOWING'),
                statLabel(profile.reputation, 'FAME'),
              ].map((label) => (
                <Text
                  key={label}
                  numberOfLines={1}
                  style={[theme.typography.overline, { color: theme.colors.gray600 }]}
                >
                  {label}
                </Text>
              ))}
            </View>
          </View>
        </View>
        {bio ? (
          <Text style={[theme.typography.caption, { color: theme.colors.gray700 }]} testID={`${testID}-bio`}>
            {bio}
          </Text>
        ) : null}
      </Pressable>

      {holdings?.status === 'loading' ? (
        <View style={styles.railSkeleton} testID={`${testID}-holdings-loading`}>
          <SkeletonBlock height={SKELETON_TILE_HEIGHT} radius={radii.xs} width={HOLDING_TILE_WIDTH} />
          <SkeletonBlock height={SKELETON_TILE_HEIGHT} radius={radii.xs} width={HOLDING_TILE_WIDTH} />
        </View>
      ) : entries.length > 0 ? (
        <ScrollView
          contentContainerStyle={styles.railContent}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          style={styles.rail}
          testID={`${testID}-holdings`}
        >
          {entries.map((entry) => {
            const kind = entry.kind === 'graded' ? 'slab' : 'raw';
            return (
              <View key={entry.id} style={[styles.tile, { backgroundColor: theme.colors.gray50 }]}>
                <InventoryCardTile
                  bordered={false}
                  cardNumber={entry.cardNumber ?? null}
                  conditionLabel={kind === 'raw' ? entry.conditionLabel ?? null : null}
                  gradeLabel={kind === 'slab' ? entry.slabContext?.grade ?? null : null}
                  graderLabel={kind === 'slab' ? entry.slabContext?.grader ?? null : null}
                  imageUrl={getCardImageUrl(entry, 'small')}
                  isFavorite={false}
                  kind={kind}
                  marketPrice={entry.marketPrice}
                  name={entry.name}
                  onPress={() => onPressHolding(profile, entry)}
                  priceLabel={formatOptionalCurrency(entry.marketPrice, 'USD')}
                  quantity={entry.quantity}
                  setName={entry.setName ?? ''}
                  showFavorite={false}
                  testID={`${testID}-holding-${entry.id}`}
                  textPreset="collection"
                  variantName={null}
                />
              </View>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  // Figma 6642:14444: 16 padding, 16 between header, bio and rail.
  card: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  headerCopy: {
    flex: 1,
    gap: spacing.xxs,
    minWidth: 0,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  identity: {
    gap: spacing.sm,
    paddingHorizontal: layout.pageGutter,
  },
  name: {
    flexShrink: 1,
  },
  nameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxxs,
  },
  rail: {
    flexGrow: 0,
  },
  railContent: {
    gap: spacing.xxxs,
    paddingHorizontal: layout.pageGutter,
  },
  railSkeleton: {
    flexDirection: 'row',
    gap: spacing.xxxs,
    overflow: 'hidden',
    paddingHorizontal: layout.pageGutter,
  },
  stats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  // Figma 6642:15541: gray-50 tile, radius 4, no border (the tile draws its own 16 padding).
  tile: {
    borderCurve: 'continuous',
    borderRadius: radii.xs,
    overflow: 'hidden',
    width: HOLDING_TILE_WIDTH,
  },
});

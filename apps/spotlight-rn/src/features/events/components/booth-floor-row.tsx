import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import type { SpotlightEventMapVendor } from '@spotlight/api-client';
import { radii, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { formatBoothPostAge } from '@/features/events/booth-format';
import type { BoothPost } from '@/features/events/booth-service';
import { PostImage } from '@/features/social/components/post-card';
import { resolveRepositoryBaseUrl } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

const CARD_WIDTH = 120;
const MAX_CARDS = 20;

type BoothFloorRowProps = {
  posts: readonly BoothPost[];
  vendors: readonly SpotlightEventMapVendor[];
  /** Tapping a card selects its vendor on the map. */
  onSelectVendor: (vendorId: string) => void;
  renderTitle: (title: string) => React.ReactNode;
};

/** "From the floor": photo booth posts, newest first. Renders nothing when there are none. */
export function BoothFloorRow({ posts, vendors, onSelectVendor, renderTitle }: BoothFloorRowProps) {
  const theme = useSpotlightTheme();
  const { accessToken, currentUser } = useAuth();
  const apiBaseUrl = resolveRepositoryBaseUrl();
  const cards = useMemo(() => {
    const byId = new Map(vendors.map((vendor) => [vendor.id, vendor]));
    return posts
      .flatMap((post) => {
        const vendor = byId.get(post.boothVendorId);
        return vendor && post.media.length > 0 ? [{ post, vendor }] : [];
      })
      .slice(0, MAX_CARDS);
  }, [posts, vendors]);

  // Post images are private until approved and only stream with a bearer token.
  if (!apiBaseUrl || !accessToken || cards.length === 0) {
    return null;
  }
  const base = apiBaseUrl.replace(/\/+$/, '');
  return (
    <View style={styles.section} testID="booth-floor-row">
      {renderTitle('From the floor')}
      <ScrollView contentContainerStyle={styles.row} horizontal showsHorizontalScrollIndicator={false}>
        {cards.map(({ post, vendor }) => {
          const media = post.media[0];
          return (
            <Pressable
              accessibilityLabel={`${vendor.name}, table ${vendor.location}`}
              accessibilityRole="button"
              key={post.id}
              onPress={() => onSelectVendor(vendor.id)}
              style={styles.card}
              testID={`booth-floor-${post.id}`}
            >
              <View style={styles.photo}>
                <PostImage
                  accessToken={accessToken}
                  media={media}
                  style={styles.photoImage}
                  uri={`${base}/api/v1/post-media/${media.id}`}
                  viewerIsAuthor={currentUser?.id === post.authorId}
                />
              </View>
              <Text numberOfLines={1} style={[theme.typography.label, { color: theme.colors.gray900 }]}>
                {vendor.name}
              </Text>
              <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.gray600 }]}>
                {[vendor.location, formatBoothPostAge(post.createdAt)].filter(Boolean).join(' · ')}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.sm,
  },
  row: {
    gap: spacing.xs,
  },
  card: {
    gap: spacing.xxxs,
    width: CARD_WIDTH,
  },
  photo: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    overflow: 'hidden',
  },
  photoImage: {
    width: CARD_WIDTH,
  },
});

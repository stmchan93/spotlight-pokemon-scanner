import { Pressable, StyleSheet, View } from 'react-native';

import type { SpotlightEventMapVendor } from '@spotlight/api-client';
import { Text, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import type { StoryRing } from '@/features/events/booth-stories';

const LOGO_INSET_RATIO = 6 / 32;
/** The story ring and the white gap inside it, each this thick. */
const RING_WIDTH = 2;
const RING_GAP = 2;

/** "Main Street Cards" -> "MS", "3vilCollections" -> "3". */
export function vendorInitials(name: string) {
  const words = name.match(/[A-Za-z0-9]+/g) ?? [];
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase() || '?';
}

type VendorLogoProps = {
  vendor: Pick<SpotlightEventMapVendor, 'id' | 'name' | 'logoUrl'>;
  size: number;
  /** A booth story: colored until watched, then gray. Drawn inside `size`, so rows don't shift. */
  ring?: StoryRing;
  /** With a ring, tapping the logo opens the story instead of the row. */
  onPress?: () => void;
};

/** The vendor's logo filling the circle, or their initials on a gray plate when there is none. */
export function VendorLogo({ vendor, size, ring = null, onPress }: VendorLogoProps) {
  const theme = useSpotlightTheme();
  const plate = ring ? size - 2 * (RING_WIDTH + RING_GAP) : size;
  const inner = Math.round(plate * (1 - 2 * LOGO_INSET_RATIO));
  const logo = (
    <View
      style={[
        styles.logo,
        {
          // Gray only behind initials: an inset logo left a gray ring around square artwork.
          backgroundColor: vendor.logoUrl ? theme.colors.gray0 : theme.colors.gray300,
          borderRadius: plate / 2,
          height: plate,
          width: plate,
        },
      ]}
      testID={`event-vendor-avatar-${vendor.id}`}
    >
      {vendor.logoUrl ? (
        <CachedImage
          cachePolicy={imageCachePolicy.full}
          contentFit="cover"
          source={{ uri: vendor.logoUrl }}
          style={{ height: plate, width: plate }}
        />
      ) : (
        // Initials scale with the plate, as `Avatar` does.
        <Text style={[theme.typography.captionStrong, { color: theme.colors.gray900, fontSize: inner * 0.55, lineHeight: inner }]}>
          {vendorInitials(vendor.name)}
        </Text>
      )}
    </View>
  );
  if (!ring) {
    return logo;
  }
  const ringed = (
    <View
      style={[
        styles.ring,
        {
          borderColor: ring === 'unseen' ? theme.colors.purple500 : theme.colors.gray300,
          borderRadius: size / 2,
          height: size,
          width: size,
        },
      ]}
      testID={`vendor-story-ring-${vendor.id}-${ring}`}
    >
      {logo}
    </View>
  );
  return onPress ? (
    <Pressable
      accessibilityLabel={`${vendor.name} booth story`}
      accessibilityRole="button"
      hitSlop={RING_GAP}
      onPress={onPress}
      testID={`vendor-story-open-${vendor.id}`}
    >
      {ringed}
    </Pressable>
  ) : (
    ringed
  );
}

const styles = StyleSheet.create({
  logo: {
    alignItems: 'center',
    borderCurve: 'continuous',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  ring: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderWidth: RING_WIDTH,
    justifyContent: 'center',
  },
});

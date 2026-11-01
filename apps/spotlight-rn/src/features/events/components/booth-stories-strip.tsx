import { Pressable, ScrollView, StyleSheet } from 'react-native';

import type { SpotlightEventMapVendor } from '@spotlight/api-client';
import { layout, spacing, Text, useSpotlightTheme } from '@spotlight/design-system';

import { storyRing, type BoothStory } from '@/features/events/booth-stories';
import { VendorLogo } from '@/features/events/components/vendor-logo';

const STORY_LOGO_SIZE = 64;
/** Room for a short name under each logo. */
const STORY_ITEM_WIDTH = 72;

type BoothStoriesStripProps = {
  /** Already ordered (unseen first). */
  stories: readonly BoothStory[];
  vendors: readonly SpotlightEventMapVendor[];
  seenPostIds: ReadonlySet<string>;
  onOpen: (vendorId: string) => void;
};

/** Ringed vendor logos for booth photo posts from the last day. Renders nothing when there are none. */
export function BoothStoriesStrip({ stories, vendors, seenPostIds, onOpen }: BoothStoriesStripProps) {
  const theme = useSpotlightTheme();
  const byId = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const items = stories.flatMap((story) => {
    const vendor = byId.get(story.vendorId);
    return vendor ? [{ story, vendor }] : [];
  });
  if (items.length === 0) {
    return null;
  }
  return (
    <ScrollView
      contentContainerStyle={styles.row}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.rowBleed}
      testID="booth-stories-strip"
    >
      {items.map(({ story, vendor }) => {
        const ring = storyRing(story, seenPostIds);
        return (
          <Pressable
            accessibilityLabel={`${vendor.name} booth story${ring === 'unseen' ? ', new' : ''}`}
            accessibilityRole="button"
            key={vendor.id}
            onPress={() => onOpen(vendor.id)}
            style={styles.item}
            testID={`booth-story-${vendor.id}`}
          >
            <VendorLogo ring={ring} size={STORY_LOGO_SIZE} vendor={vendor} />
            <Text numberOfLines={1} style={[theme.typography.caption, styles.name, { color: theme.colors.gray800 }]}>
              {vendor.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Scrolls edge to edge while the first logo lines up with the gutter.
  rowBleed: {
    marginHorizontal: -layout.pageGutter,
  },
  row: {
    gap: spacing.xs,
    paddingHorizontal: layout.pageGutter,
  },
  item: {
    alignItems: 'center',
    gap: spacing.xxxs,
    width: STORY_ITEM_WIDTH,
  },
  name: {
    textAlign: 'center',
  },
});

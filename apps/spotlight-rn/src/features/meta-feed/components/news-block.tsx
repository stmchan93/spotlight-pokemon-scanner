import { StyleSheet, View } from 'react-native';

import { gameDisplayName, type NewsFeed, type NewsItem } from '@spotlight/api-client';
import { NewsRow, useSpotlightTheme } from '@spotlight/design-system';

import { MetaBlockHeader } from '@/features/meta-feed/components/meta-block-header';
import { NEWS_FEED_BLOCK_LIMIT } from '@/features/meta-feed/hooks/use-meta-feed';
import {
  newsSourceLine,
} from '@/features/meta-feed/screens/components/meta-format';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';

/** Chips under a headline: the game first, then the item's own tags; ≤ 3. */
export function newsItemChips(item: Pick<NewsItem, 'game' | 'tags'>): string[] {
  const chips = [item.game ? gameDisplayName(item.game) : null, ...item.tags]
    .filter((chip): chip is string => Boolean(chip));
  return [...new Set(chips)].slice(0, 3);
}

export function hasNewsContent(feed: NewsFeed | null): boolean {
  return feed != null && feed.items.length > 0;
}

export type NewsBlockProps = {
  feed: NewsFeed | null;
  /** "All news ›"; the feed pushes `/news`. */
  onOpenNews?: () => void;
  /** Headline taps; defaults to the in-app browser. */
  onOpenLink?: (url: string) => void;
  showBand?: boolean;
  testID?: string;
};

/**
 * Social feed "Card news": the latest three headlines, linking out to the
 * source. Headline + source + thumbnail only; never article text.
 */
export function NewsBlock({
  feed,
  onOpenNews,
  onOpenLink = (url) => void openLinkOut(url),
  showBand = true,
  testID = 'card-news',
}: NewsBlockProps) {
  const theme = useSpotlightTheme();
  if (!feed || !hasNewsContent(feed)) {
    return null;
  }
  const items = feed.items.slice(0, NEWS_FEED_BLOCK_LIMIT);

  return (
    <View
      style={[
        styles.section,
        { borderBottomColor: theme.colors.gray100, borderBottomWidth: showBand ? 4 : 0 },
      ]}
      testID={testID}
    >
      <MetaBlockHeader
        actionLabel="All news ›"
        onPressAction={onOpenNews}
        testID={`${testID}-header`}
        title="Card news"
      />
      <View style={styles.rows}>
        {items.map((item, index) => (
          <NewsRow
            divider={index < items.length - 1}
            imageUrl={item.imageUrl}
            key={item.id}
            onPress={() => onOpenLink(item.url)}
            sourceLabel={newsSourceLine(item)}
            tags={newsItemChips(item)}
            testID={`${testID}-row-${item.id}`}
            title={item.title}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    alignSelf: 'stretch',
    padding: 16,
    width: '100%',
  },
  rows: {
    marginTop: 8,
  },
});

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CARD_GAMES,
  DEFAULT_CARD_GAME,
  gameDisplayName,
  type CardGame,
  type InventoryCardEntry,
  type NewsFeedQuery,
  type NewsItem,
  type NewsKind,
} from '@spotlight/api-client';
import {
  NewsRow,
  PillButton,
  SkeletonBlock,
  StateCard,
  Text,
  VideoTile,
  borderWidths,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import {
  formatDuration,
  newsSourceLine,
  videoMetaLine,
} from '@/features/meta-feed/screens/components/meta-format';
import { MetaPageHeader } from '@/features/meta-feed/screens/components/meta-page-chrome';
import { useNewsPageData } from '@/features/meta-feed/screens/components/meta-page-data';
import { NewsCardChips, type NewsCardChip } from '@/features/meta-feed/screens/components/news-card-chips';
import { openLinkOut } from '@/features/meta-feed/screens/components/open-link-out';
import { useAppServices } from '@/providers/app-providers';

export const NEWS_PAGE_SIZE = 20;
const LEAD_IMAGE_HEIGHT = 190;
/** Named cards shown as chips before the rest collapse into a count. */
const MAX_NAMED_CARD_CHIPS = 3;
export const NEWS_FOOTER_COPY = 'Headlines and thumbnails link out to the source.';

export const NEWS_KIND_CHIPS: readonly { label: string; value: NewsKind | null }[] = [
  { label: 'All', value: null },
  { label: 'News', value: 'news' },
  { label: 'Market', value: 'market' },
  { label: 'Videos', value: 'video' },
  { label: 'Community', value: 'community' },
];

/** Games in the user's collection, in `CARD_GAMES` order (no game = Pokémon). */
export function newsCollectionGames(entries: readonly InventoryCardEntry[] | null): CardGame[] {
  if (!entries || entries.length === 0) {
    return [];
  }
  const present = new Set(entries.map((entry) => entry.game ?? DEFAULT_CARD_GAME));
  return CARD_GAMES.filter((game) => present.has(game));
}

/** The first item with a thumbnail leads the page; everything else is a row. */
export function splitLead(items: readonly NewsItem[]): { lead: NewsItem | null; rest: NewsItem[] } {
  const lead = items.find((item) => item.kind !== 'video' && item.imageUrl) ?? null;
  return { lead, rest: lead ? items.filter((item) => item.id !== lead.id) : [...items] };
}

/**
 * Card chips for a story: owned cards by name, then any others as one count
 * chip (the payload carries ids only, and an id is not a label).
 */
export function newsCardChips(cardIds: readonly string[], ownedNames: ReadonlyMap<string, string>): NewsCardChip[] {
  const named = cardIds
    .filter((cardId) => ownedNames.has(cardId))
    .slice(0, MAX_NAMED_CARD_CHIPS)
    .map((cardId) => ({ cardId, label: ownedNames.get(cardId) as string }));
  const others = cardIds.filter((cardId) => !named.some((chip) => chip.cardId === cardId));
  if (others.length === 0) {
    return named;
  }
  const label = named.length > 0
    ? `+${others.length} more`
    : `${others.length} tagged card${others.length === 1 ? '' : 's'}`;
  return [...named, { cardId: others[0], label }];
}

function itemTags(item: NewsItem): string[] {
  const tags = item.game ? [gameDisplayName(item.game), ...item.tags] : [...item.tags];
  return [...new Set(tags)];
}

export type NewsScreenProps = {
  initialGame?: CardGame | null;
  initialKind?: NewsKind | null;
  onBack: () => void;
  onOpenCard: (cardId: string) => void;
};

/**
 * News & videos page (docs/meta-feed-mockup/News.dc.html): headlines and
 * videos tagged to games/sets/cards, filtered by kind (and game, when the
 * collection spans games), paged by `nextCursor`. Everything links out.
 */
export function NewsScreen({ initialGame = null, initialKind = null, onBack, onOpenCard }: NewsScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { inventoryEntriesCache, spotlightRepository } = useAppServices();
  const [kind, setKind] = useState<NewsKind | null>(initialKind);
  const [game, setGame] = useState<CardGame | null>(initialGame);
  const [refreshing, setRefreshing] = useState(false);

  const query = useMemo<NewsFeedQuery>(() => ({ game, kind, limit: NEWS_PAGE_SIZE }), [game, kind]);
  const { data: firstPage, loading, refresh, status } = useNewsPageData(query);

  // Pages after the first, fetched here: the shared hook caches one page per query.
  const [extraItems, setExtraItems] = useState<NewsItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageTokenRef = useRef(0);

  useEffect(() => {
    pageTokenRef.current += 1;
    setExtraItems([]);
    setNextCursor(firstPage?.nextCursor ?? null);
    setLoadingMore(false);
  }, [firstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) {
      return;
    }
    const token = pageTokenRef.current;
    setLoadingMore(true);
    try {
      const page = await spotlightRepository.fetchNewsFeed({ ...query, cursor: nextCursor });
      if (token !== pageTokenRef.current) {
        return;
      }
      setExtraItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...(page?.items ?? []).filter((item) => !seen.has(item.id))];
      });
      setNextCursor(page?.nextCursor ?? null);
    } catch (error) {
      // Leave the cursor so the next end-reached retries.
      console.warn('[meta-feed] news page fetch failed', error);
    } finally {
      if (token === pageTokenRef.current) {
        setLoadingMore(false);
      }
    }
  }, [loadingMore, nextCursor, query, spotlightRepository]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const games = useMemo(() => newsCollectionGames(inventoryEntriesCache), [inventoryEntriesCache]);
  const ownedNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of inventoryEntriesCache ?? []) {
      names.set(entry.cardId, entry.name);
    }
    return names;
  }, [inventoryEntriesCache]);

  const items = useMemo(() => {
    const first = firstPage?.items ?? [];
    const seen = new Set(first.map((item) => item.id));
    return [...first, ...extraItems.filter((item) => !seen.has(item.id))];
  }, [extraItems, firstPage]);
  const { lead, rest } = useMemo(() => splitLead(items), [items]);

  const renderItem = useCallback(
    ({ index, item }: { index: number; item: NewsItem }) => {
      const chips = newsCardChips(item.cardIds, ownedNames);
      const isLast = index === rest.length - 1;
      return (
        <View
          style={[
            styles.item,
            isLast ? null : { borderBottomColor: theme.colors.gray300, borderBottomWidth: borderWidths.rule },
          ]}
        >
          {item.kind === 'video' ? (
            <VideoTile
              durationLabel={item.video?.durationSeconds != null ? formatDuration(item.video.durationSeconds) : null}
              imageUrl={item.imageUrl}
              metaLabel={videoMetaLine(item)}
              onPress={() => void openLinkOut(item.url)}
              testID={`news-item-${item.id}`}
              layout="row"
              title={item.title}
            />
          ) : (
            <NewsRow
              imageUrl={item.imageUrl}
              onPress={() => void openLinkOut(item.url)}
              sourceLabel={newsSourceLine(item)}
              tags={itemTags(item)}
              testID={`news-item-${item.id}`}
              title={item.title}
            />
          )}
          <NewsCardChips chips={chips} onOpenCard={onOpenCard} testID={`news-cards-${item.id}`} />
        </View>
      );
    },
    [onOpenCard, ownedNames, rest.length, theme.colors.gray300],
  );

  const filters = (
    <View>
      <ScrollView
        horizontal
        contentContainerStyle={styles.chipRow}
        showsHorizontalScrollIndicator={false}
        testID="news-kind-chips"
      >
        {NEWS_KIND_CHIPS.map((chip) => (
          <PillButton
            key={chip.label}
            label={chip.label}
            onPress={() => setKind(chip.value)}
            selected={chip.value === kind}
            style={styles.chip}
            testID={`news-kind-${chip.value ?? 'all'}`}
            tone="filter"
          />
        ))}
      </ScrollView>
      {games.length > 1 ? (
        <ScrollView
          horizontal
          contentContainerStyle={styles.chipRow}
          showsHorizontalScrollIndicator={false}
          testID="news-game-chips"
        >
          {[null, ...games].map((candidate) => (
            <PillButton
              key={candidate ?? 'all'}
              label={candidate ? gameDisplayName(candidate) : 'All games'}
              onPress={() => setGame(candidate)}
              selected={candidate === game}
              style={styles.chip}
              testID={`news-game-${candidate ?? 'all'}`}
              tone="filter"
            />
          ))}
        </ScrollView>
      ) : null}
      {games.length > 0 ? (
        <Text style={[theme.typography.captionMedium, styles.gamesCaption]} testID="news-games-caption">
          {`Games in your collection · ${games.map(gameDisplayName).join(', ')}`}
        </Text>
      ) : null}
    </View>
  );

  const header = (
    <View>
      {filters}
      {lead ? (
        <LeadStory item={lead} onOpenCard={onOpenCard} ownedNames={ownedNames} showBand={rest.length > 0} />
      ) : null}
    </View>
  );

  const empty = firstPage ? (
    lead ? null : (
      <View style={styles.stateWrap}>
        <StateCard
          message={kind || game ? 'Nothing here yet for this filter. Try another one.' : 'Check back soon for headlines and videos.'}
          testID="news-empty"
          title="No stories yet"
          variant="muted"
        />
      </View>
    )
  ) : status === 'loading' ? (
    <View style={styles.skeleton} testID="news-loading">
      <SkeletonBlock height={LEAD_IMAGE_HEIGHT} radius={radii.md} />
      {Array.from({ length: 4 }).map((_, index) => (
        <SkeletonBlock key={index} height={72} radius={radii.sm} />
      ))}
    </View>
  ) : (
    <View style={styles.stateWrap}>
      {status === 'disabled' ? (
        <StateCard
          message="News and videos aren't switched on yet. Check back soon."
          testID="news-disabled"
          title="Coming soon"
          variant="muted"
        />
      ) : (
        <StateCard
          actionLabel="Try again"
          actionTestID="news-retry"
          message="We couldn't load the latest stories. Check your connection and try again."
          onActionPress={() => void refresh()}
          testID="news-error"
          title="News isn't available right now"
        />
      )}
    </View>
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.safeArea, { backgroundColor: theme.colors.gray0 }]}>
      <MetaPageHeader onBack={onBack} testID="news-header" title="News & videos" />
      <FlatList
        ListEmptyComponent={empty}
        ListFooterComponent={
          <View style={styles.footer}>
            {loadingMore ? <ActivityIndicator color={theme.colors.gray400} testID="news-loading-more" /> : null}
            {items.length > 0 ? (
              <Text style={[theme.typography.cardMeta, { color: theme.colors.gray600 }]} testID="news-footer">
                {NEWS_FOOTER_COPY}
              </Text>
            ) : null}
          </View>
        }
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        data={rest}
        keyExtractor={(item) => item.id}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        refreshControl={<RefreshControl onRefresh={handleRefresh} refreshing={refreshing} />}
        renderItem={renderItem}
        style={loading && firstPage ? styles.stale : null}
        testID="news-list"
      />
    </SafeAreaView>
  );
}

function LeadStory({
  item,
  onOpenCard,
  ownedNames,
  showBand,
}: {
  item: NewsItem;
  onOpenCard: (cardId: string) => void;
  ownedNames: ReadonlyMap<string, string>;
  showBand: boolean;
}) {
  const theme = useSpotlightTheme();
  const tags = itemTags(item);
  return (
    <View
      style={[
        styles.lead,
        showBand ? { borderBottomColor: theme.colors.gray100, borderBottomWidth: spacing.xxxs } : null,
      ]}
      testID="news-lead"
    >
      <Pressable
        accessibilityHint="Opens the article"
        accessibilityLabel={`${item.title}, ${item.source}`}
        accessibilityRole="link"
        onPress={() => void openLinkOut(item.url)}
        style={({ pressed }) => ({ opacity: pressed ? 0.86 : 1 })}
        testID={`news-item-${item.id}`}
      >
        <View style={[styles.leadImage, { backgroundColor: theme.colors.gray200 }]}>
          {item.imageUrl ? (
            <CachedImage cachePolicy={imageCachePolicy.hero} style={styles.fill} uri={item.imageUrl} />
          ) : null}
        </View>
        <Text style={[theme.typography.cardMetaStrong, styles.leadSource, { color: theme.colors.gray700 }]}>
          {newsSourceLine(item)}
        </Text>
        <Text style={[theme.typography.titleSmall, styles.leadTitle]}>{item.title}</Text>
      </Pressable>
      {tags.length > 0 ? (
        <View style={styles.leadTags}>
          {tags.map((tag) => (
            <View key={tag} style={[styles.tag, { borderColor: theme.colors.gray300 }]}>
              <Text style={[theme.typography.chipLabel, { color: theme.colors.gray700 }]}>{tag}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <NewsCardChips
        chips={newsCardChips(item.cardIds, ownedNames)}
        onOpenCard={onOpenCard}
        testID={`news-cards-${item.id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderRadius: radii.pill,
  },
  chipRow: {
    gap: spacing.xxs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  fill: {
    height: '100%',
    width: '100%',
  },
  footer: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  gamesCaption: {
    paddingBottom: spacing.xxs,
    paddingHorizontal: spacing.sm,
  },
  item: {
    gap: spacing.xxs,
    marginHorizontal: spacing.sm,
    paddingVertical: spacing.xxxs,
  },
  lead: {
    gap: spacing.xxs,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xxs,
  },
  leadImage: {
    borderCurve: 'continuous',
    borderRadius: radii.md,
    height: LEAD_IMAGE_HEIGHT,
    overflow: 'hidden',
  },
  leadSource: {
    marginTop: 10,
  },
  leadTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  leadTitle: {
    marginTop: 2,
  },
  safeArea: {
    flex: 1,
  },
  skeleton: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  stale: {
    opacity: 0.6,
  },
  stateWrap: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xxs,
  },
  tag: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    borderWidth: borderWidths.containerRule,
    height: 22,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxs,
  },
});

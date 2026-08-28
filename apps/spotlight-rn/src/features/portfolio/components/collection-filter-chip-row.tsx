import { ScrollView, StyleSheet, View } from 'react-native';

import {
  type CardGame,
  CARD_GAMES,
  gameDisplayName,
  RARITY_BUCKET_LABELS,
  RARITY_FILTER_BUCKETS,
  type RarityFilterBucket,
} from '@spotlight/api-client';
import { PillButton } from '@spotlight/design-system';

/**
 * A per-game filter key, e.g. `game:onepiece`. Namespaced rather than using the
 * bare game id so a future game can never collide with a rarity bucket or a
 * sort key, and so `isGameFilterKey` can tell the two apart without a lookup.
 */
export type GameFilterKey = `game:${CardGame}`;

export type CollectionFilterKey =
  | 'all'
  | 'az'
  | 'price'
  | 'favorites'
  | 'ungraded'
  | 'graded'
  | GameFilterKey
  | RarityFilterBucket;

/** The fixed chips, in order. Game chips are inserted after these — see below. */
export const COLLECTION_FILTER_ORDER: CollectionFilterKey[] = [
  'all',
  'az',
  'price',
  'favorites',
  'ungraded',
  'graded',
  ...RARITY_FILTER_BUCKETS,
];

export function gameFilterKey(game: CardGame): GameFilterKey {
  return `game:${game}`;
}

export function isGameFilterKey(key: CollectionFilterKey): key is GameFilterKey {
  return key.startsWith('game:');
}

/** The game a game-chip filters to, or null for any other filter key. */
export function gameFromFilterKey(key: CollectionFilterKey): CardGame | null {
  if (!isGameFilterKey(key)) {
    return null;
  }
  const game = key.slice('game:'.length) as CardGame;
  return CARD_GAMES.includes(game) ? game : null;
}

const FILTER_LABELS: Record<Exclude<CollectionFilterKey, GameFilterKey>, string> = {
  all: 'All',
  az: 'A-Z',
  // The sort is highest-first, so the label leads with the expensive end.
  price: '$$$',
  favorites: 'Likes',
  ungraded: 'Ungraded',
  graded: 'Graded',
  // Rarity chip labels live in the api-client (single client home).
  ...RARITY_BUCKET_LABELS,
};

function chipLabel(key: CollectionFilterKey): string {
  const game = gameFromFilterKey(key);
  // Game names come from the capability table, never from a local string map —
  // one place decides that `onepiece` reads as "One Piece".
  return game ? gameDisplayName(game) : FILTER_LABELS[key as Exclude<CollectionFilterKey, GameFilterKey>];
}

type CollectionFilterChipRowProps = {
  activeFilter: CollectionFilterKey;
  /**
   * The games actually present in the collection being shown. One game (or
   * none) offers NO game chips: a filter that can only ever return everything
   * or nothing is clutter, and the overwhelmingly common collection is
   * Pokémon-only. Two or more and the chips appear, in `CARD_GAMES` order.
   */
  games?: readonly CardGame[];
  onFilterChange: (next: CollectionFilterKey) => void;
  testID?: string;
};

export function CollectionFilterChipRow({
  activeFilter,
  games = [],
  onFilterChange,
  testID = 'collection-filter-chip-row',
}: CollectionFilterChipRowProps) {
  const gameKeys: CollectionFilterKey[] = games.length > 1
    ? CARD_GAMES.filter((game) => games.includes(game)).map(gameFilterKey)
    : [];
  // Game chips sit after the lane chips and before the rarity buckets: "which
  // game" is a coarser cut than "which rarity", so it reads left of it.
  const rarityStart = COLLECTION_FILTER_ORDER.indexOf(RARITY_FILTER_BUCKETS[0]);
  const keys = [
    ...COLLECTION_FILTER_ORDER.slice(0, rarityStart),
    ...gameKeys,
    ...COLLECTION_FILTER_ORDER.slice(rarityStart),
  ];

  return (
    <ScrollView
      contentContainerStyle={styles.scrollContent}
      horizontal
      showsHorizontalScrollIndicator={false}
      testID={testID}
    >
      <View style={styles.chipRow}>
        {keys.map((key) => (
          <PillButton
            key={key}
            label={chipLabel(key)}
            onPress={() => onFilterChange(key)}
            selected={activeFilter === key}
            testID={`${testID}-${key}`}
            tone="filter"
          />
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 16,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
  },
});

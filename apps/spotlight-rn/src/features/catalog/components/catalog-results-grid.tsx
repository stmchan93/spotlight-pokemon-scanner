import type { ReactElement } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  DEFAULT_CARD_GAME,
  gameDisplayName,
  type CardGame,
  type CatalogSearchResult,
} from '@spotlight/api-client';
import { InventoryCardTile, colors } from '@spotlight/design-system';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/**
 * The two-up grid of card results, shared by every catalog search surface.
 *
 * Collectr-style chunked rows of two shared tiles (the repo's grid convention —
 * see wishlist-screen.tsx), NOT `FlatList` `numColumns`.
 */

const GRID_COLUMNS = 2;

export function chunkResultRows(entries: CatalogSearchResult[]): CatalogSearchResult[][] {
  const rows: CatalogSearchResult[][] = [];
  for (let index = 0; index < entries.length; index += GRID_COLUMNS) {
    rows.push(entries.slice(index, index + GRID_COLUMNS));
  }
  return rows;
}

/**
 * Whether these results need a per-tile game tag.
 *
 * A TYPED QUERY ON THE TOP-LEVEL SEARCH SPANS EVERY GAME, so mixed results are
 * the normal case there and a tile saying only "Ace" has to say which game it
 * came from. Tagging every tile when they all share one game would just repeat
 * one word down the page — which is also why a search scoped to a single game
 * never shows the tag.
 */
export function resultsSpanMultipleGames(results: CatalogSearchResult[]): boolean {
  const games = new Set<CardGame>();
  for (const result of results) {
    games.add(result.game ?? DEFAULT_CARD_GAME);
    if (games.size > 1) {
      return true;
    }
  }
  return false;
}

/** One result tile — the grid's cell, and the sealed row's item on the search screen. */
export function SearchResultTile({
  result,
  onPress,
  showGameTag = false,
  artAspect = 'card',
  style = styles.gridCell,
  testIDPrefix = 'catalog-result',
}: {
  result: CatalogSearchResult;
  onPress: () => void;
  showGameTag?: boolean;
  artAspect?: 'square' | 'card';
  style?: StyleProp<ViewStyle>;
  /** Wrapper is `${prefix}-${id}`, the tile `${prefix}-smoke-${cardId}`. */
  testIDPrefix?: string;
}) {
  return (
    <View style={style} testID={`${testIDPrefix}-${result.id}`}>
      <InventoryCardTile
        artAspect={artAspect}
        // Sealed product has no number; its type ("Elite Trainer Box") takes the slot.
        cardNumber={result.productKind === 'sealed' ? result.sealedProductType ?? null : result.cardNumber}
        /*
          Game UNDER THE PRICE, inside the tile's caption — it used to render
          after the tile entirely, which put it past the tile's padding where it
          read as a label on the row rather than on the card.
        */
        footnote={showGameTag ? gameDisplayName(result.game) : null}
        imageUrl={result.smallImageUrl ?? result.imageUrl ?? null}
        isFavorite={false}
        kind="raw"
        name={result.name}
        onPress={onPress}
        priceLabel={
          result.marketPrice != null
            ? formatCurrency(result.marketPrice, result.currencyCode ?? 'USD')
            : null
        }
        quantity={result.ownedQuantity ?? 0}
        // Set name only — no per-row rarity tag; the chips above already say it.
        setName={result.subtitle?.trim() ? result.subtitle : result.setName}
        showFavorite={false}
        showQualityLine={false}
        // The tile's quantity readout IS the "Owned N" signal; hidden when 0.
        showQuantity={Boolean(result.ownedQuantity)}
        testID={`${testIDPrefix}-smoke-${result.cardId}`}
      />
    </View>
  );
}

export type CatalogResultsGridProps = {
  results: CatalogSearchResult[];
  onOpenResult: (result: CatalogSearchResult) => void;
  /** The tile mid-navigation; it ignores re-taps until the push settles. */
  openingResultId?: string | null;
  isLoadingMore?: boolean;
  onEndReached?: () => void;
  /**
   * Tag each tile with its game. Recomputed by the caller per results change so
   * a "load more" page that brings in a second game turns the tags on for the
   * whole list rather than only the new rows.
   */
  showGameTags?: boolean;
  /** Scrolls with the rows, above the first one (the sealed row on search). */
  header?: ReactElement | null;
  testID?: string;
};

export function CatalogResultsGrid({
  results,
  onOpenResult,
  openingResultId = null,
  isLoadingMore = false,
  onEndReached,
  showGameTags = false,
  header = null,
  testID = 'catalog-results-list',
}: CatalogResultsGridProps) {
  return (
    <FlatList
      contentContainerStyle={styles.listContent}
      data={chunkResultRows(results)}
      key="results"
      keyExtractor={(row) => row[0].id}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      ListFooterComponent={isLoadingMore ? (
        <View style={styles.loadMoreFooter} testID="catalog-load-more-spinner">
          <ActivityIndicator color={colors.gray400} />
        </View>
      ) : null}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      renderItem={({ item: row }) => (
        <View style={styles.gridRow}>
          {row.map((result) => (
            <SearchResultTile
              key={result.id}
              onPress={() => {
                if (openingResultId === result.id) {
                  return;
                }
                onOpenResult(result);
              }}
              result={result}
              showGameTag={showGameTags}
            />
          ))}
          {/* A lone tile keeps one column's width, not the full row. */}
          {row.length < GRID_COLUMNS ? <View style={styles.gridCell} /> : null}
        </View>
      )}
      showsVerticalScrollIndicator={false}
      style={styles.body}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  gridCell: {
    flex: 1,
  },
  gridRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: 12,
  },
  listContent: {
    gap: 12,
    paddingBottom: 48,
    paddingHorizontal: 16,
    // Matches the browse grid that shares this slot — differing top padding
    // would shift the row above as you type.
    paddingTop: 0,
  },
  loadMoreFooter: {
    alignItems: 'center',
    paddingVertical: 16,
  },
});

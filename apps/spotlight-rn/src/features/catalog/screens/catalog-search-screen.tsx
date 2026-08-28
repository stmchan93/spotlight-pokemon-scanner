import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  ScrollView,
  StyleSheet,
  type TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DEFAULT_CARD_GAME,
  gameDisplayName,
  RARITY_BUCKET_LABELS,
  RARITY_FILTER_BUCKETS,
  type CardGame,
  type CatalogSearchResult,
  type ExpansionRecord,
  type RarityFilterBucket,
} from '@spotlight/api-client';
import {
  InventoryCardTile,
  PillButton,
  ScreenHeader,
  SearchField,
  StateCard,
  Text,
  Toast,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { consumeCardAddedNotice } from '@/features/cards/card-added-notice';
import { ChromeBackButton } from '@/components/chrome-back-button';
import { ExpansionCell } from '@/features/catalog/components/expansion-cell';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

/*
  CARDS ONLY. This screen used to carry a second "People" lane behind a
  Cards/People `SegmentedControl` that appeared once you typed — prefix-matching
  @handles and display names via `searchUsers`, and routing to `/u/[handle]`.
  It is gone deliberately: this is the destination of a pill that says "Search
  Cards", and a segment that silently re-points the same query at collectors
  made the one thing the surface promises ambiguous.

  `searchUsers` itself is untouched and still live — the DM inbox is where you
  look someone up, and post authors in the feed still link to their profiles. If
  people-search ever comes back it belongs on its own surface, not folded into
  this one.
*/

// Results load a page at a time as the user scrolls (infinite scroll), so an
// artist search surfaces ALL of a prolific illustrator's cards, not just the
// first page.
const CATALOG_PAGE_SIZE = 30;

type CatalogSearchScreenProps = {
  initialQuery?: string;
  /**
   * Game whose expansions populate the browse grid. Typed as `CardGame` rather
   * than `string` so a lane can only ever be one the capability table knows;
   * absent means Pokémon, as everywhere.
   */
  game?: CardGame;
  onClose: () => void;
  onOpenCard: (result: CatalogSearchResult) => void;
  /**
   * Tap handler for a set in the browse grid. When provided, the empty state
   * shows every expansion (logo + name) so users can drill into one and search
   * within it; typing in the search box still searches all cards globally.
   */
  onSelectExpansion?: (expansion: ExpansionRecord) => void;
};

// Collectr-style results grid: chunked rows of two shared tiles (the repo's
// grid convention — see wishlist-screen.tsx), NOT FlatList numColumns.
const GRID_COLUMNS = 2;

function chunkResultRows(entries: CatalogSearchResult[]): CatalogSearchResult[][] {
  const rows: CatalogSearchResult[][] = [];
  for (let index = 0; index < entries.length; index += GRID_COLUMNS) {
    rows.push(entries.slice(index, index + GRID_COLUMNS));
  }
  return rows;
}

/**
 * Whether these results need a per-tile game tag.
 *
 * Search is scoped to one game — the lane's — so in practice this is false and
 * no tag renders. It is kept because the scoping lives in the REQUEST, not in
 * the row shape: a caller that omits the game (or a future cross-game search)
 * gets mixed results, and then a tile saying only "Ace" cannot say which game
 * it came from. Tagging every tile of a single-game set would just repeat one
 * word down the page, so the tag appears only when the results SPAN games.
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

function SearchResultTile({
  result,
  onPress,
  showGameTag = false,
}: {
  result: CatalogSearchResult;
  onPress: () => void;
  showGameTag?: boolean;
}) {
  const theme = useSpotlightTheme();
  return (
    <View style={styles.gridCell} testID={`catalog-result-${result.id}`}>
      <InventoryCardTile
        artAspect="card"
        cardNumber={result.cardNumber}
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
        testID={`catalog-result-smoke-${result.cardId}`}
      />
      {/*
        Game tag BELOW the tile, not inside it: `InventoryCardTile` is a shared
        primitive and a search-only concern doesn't belong on its prop surface.
        Renders only when the result set spans games — see
        `resultsSpanMultipleGames`.
      */}
      {showGameTag ? (
        <Text
          style={[theme.typography.caption, { color: theme.colors.textSecondary }]}
          testID={`catalog-result-game-${result.id}`}
        >
          {gameDisplayName(result.game)}
        </Text>
      ) : null}
    </View>
  );
}

export function CatalogSearchScreen({
  initialQuery = '',
  game = DEFAULT_CARD_GAME,
  onClose,
  onOpenCard,
  onSelectExpansion,
}: CatalogSearchScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { spotlightRepository } = useAppServices();

  const [query, setQuery] = useState(initialQuery);
  // Single-select rarity chip; tap again to clear. Sent to the backend as the
  // `rarityBucket` search param (a chip alone is a valid browse-by-rarity).
  const [activeRarity, setActiveRarity] = useState<RarityFilterBucket | null>(null);
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [searchRevision, setSearchRevision] = useState(0);
  const [openingResultId, setOpeningResultId] = useState<string | null>(null);
  /*
    On FOCUS, not mount: this screen stays mounted under the card page, so a
    mount effect would run before the add ever happened.
  */
  const [addedNotice, setAddedNotice] = useState<string | null>(null);
  // The real TextInput inside SearchField — blurred when a result opens, so no
  // focus survives to be restored when the card page pops back to this screen.
  const searchFieldRef = useRef<TextInput>(null);
  useFocusEffect(
    useCallback(() => {
      const notice = consumeCardAddedNotice();
      if (notice) {
        setAddedNotice(notice);
        /*
          The add is DONE — the search that led to it is over. Clear the query
          and drop the keyboard so the toast at the bottom is actually visible:
          returning here with the old text still in the field kept the keyboard
          up, and the keyboard sat exactly where the toast renders.
        */
        setQuery('');
        Keyboard.dismiss();
      }
    }, []),
  );
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // The query the current results belong to — guards against a late "load more"
  // response from a previous query being appended after the query changed.
  const activeQueryRef = useRef('');
  const openingResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Browse grid: every expansion, shown when the search box is empty so users
  // can drill into a set. Only fetched when a tap handler is wired.
  const browseEnabled = Boolean(onSelectExpansion);
  const [expansions, setExpansions] = useState<ExpansionRecord[]>([]);
  const [isLoadingExpansions, setIsLoadingExpansions] = useState(browseEnabled);
  const [hasLoadedExpansions, setHasLoadedExpansions] = useState(false);
  const [expansionError, setExpansionError] = useState('');

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (!browseEnabled) {
      return;
    }
    let cancelled = false;
    setIsLoadingExpansions(true);
    setExpansionError('');
    void spotlightRepository.listExpansions(game)
      .then((rows) => {
        if (cancelled) return;
        setExpansions(rows);
        setHasLoadedExpansions(true);
        setIsLoadingExpansions(false);
      })
      .catch(() => {
        if (cancelled) return;
        setExpansionError('Could not load sets. Try again in a moment.');
        setHasLoadedExpansions(true);
        setIsLoadingExpansions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [browseEnabled, game, spotlightRepository]);

  useEffect(() => {
    return () => {
      if (openingResetTimerRef.current) {
        clearTimeout(openingResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    // A rarity chip alone is a valid search (browse-by-rarity, no text).
    if (trimmed.length < 2 && !activeRarity) {
      setResults([]);
      setHasSearched(false);
      setIsLoading(false);
      setErrorMessage('');
      setOpeningResultId(null);
      setHasMore(false);
      setIsLoadingMore(false);
      activeQueryRef.current = '';
      return;
    }

    // Text + chip form one logical search; the key guards late "load more"
    // pages when either input changes while a page is in flight.
    const searchKey = `${trimmed}::${activeRarity ?? ''}`;

    setHasSearched(false);
    setErrorMessage('');

    let isCancelled = false;
    const timeout = setTimeout(() => {
      setIsLoading(true);

      // First page: replace results. Later pages append via loadMore below.
      void spotlightRepository.searchCatalogCardsPage(
        trimmed,
        CATALOG_PAGE_SIZE,
        0,
        { game, ...(activeRarity ? { rarityBucket: activeRarity } : {}) },
      )
        .then((page) => {
          if (isCancelled) {
            return;
          }

          activeQueryRef.current = searchKey;
          // Fired on the settled query only — the 275ms debounce above means
          // typing "charizard" costs one event, not nine.
          //
          // The query TEXT deliberately does not travel. `cardname` is already
          // on the observability redact list, so shipping the same string under
          // a friendlier key would just route around that decision. What this
          // answers is "how often does search come back empty" — if a catalog
          // coverage gap needs naming, that analysis belongs in backend search
          // logs, where the text already lives.
          capturePostHogEvent('catalog_search_performed', {
            has_rarity_filter: activeRarity != null,
            query_length: trimmed.length,
            result_count: page.cards.length,
          });
          setResults(page.cards);
          setHasMore(page.hasMore);
          setIsLoadingMore(false);
          setHasSearched(true);
          setIsLoading(false);
          setOpeningResultId(null);
        })
        .catch(() => {
          if (isCancelled) {
            return;
          }

          setResults([]);
          setHasMore(false);
          setIsLoadingMore(false);
          setHasSearched(true);
          setIsLoading(false);
          setErrorMessage('Search unavailable right now. Try again in a moment.');
          setOpeningResultId(null);
        });
    }, 275);

    return () => {
      isCancelled = true;
      clearTimeout(timeout);
    };
    // `game` is a dependency: switching lanes has to re-run the search, not
    // leave the previous game's results on screen.
  }, [activeRarity, game, query, searchRevision, spotlightRepository]);

  const trimmedQuery = query.trim();
  const hasActiveQuery = trimmedQuery.length >= 2 || activeRarity != null;
  const hasVisibleResults = hasActiveQuery && !errorMessage && results.length > 0;

  const openResult = (result: CatalogSearchResult) => {
    // Paired with `catalog_search_performed`: searches that open nothing are
    // how you tell a working search from one nobody trusts the results of.
    capturePostHogEvent('catalog_search_result_opened', {
      has_rarity_filter: activeRarity != null,
      result_count: results.length,
    });

    if (openingResetTimerRef.current) {
      clearTimeout(openingResetTimerRef.current);
    }
    /*
      Blur NOW, while the field actually holds focus — not on the way back.
      The added-notice focus effect also dismisses, but it runs as this screen
      regains focus, BEFORE the field re-acquires first responder during the
      pop transition, so the keyboard came straight back ("I'm still focused
      on the search input after adding"). Dropping focus at departure means
      there is nothing to restore on return.
    */
    searchFieldRef.current?.blur();
    Keyboard.dismiss();
    setOpeningResultId(result.id);
    onOpenCard(result);
    openingResetTimerRef.current = setTimeout(() => {
      setOpeningResultId((current) => (current === result.id ? null : current));
      openingResetTimerRef.current = null;
    }, 350);
  };

  const loadMore = useCallback(() => {
    const trimmed = query.trim();
    if ((trimmed.length < 2 && !activeRarity) || isLoading || isLoadingMore || !hasMore) {
      return;
    }
    const searchKey = `${trimmed}::${activeRarity ?? ''}`;
    setIsLoadingMore(true);
    const offset = results.length;
    void spotlightRepository.searchCatalogCardsPage(
      trimmed,
      CATALOG_PAGE_SIZE,
      offset,
      { game, ...(activeRarity ? { rarityBucket: activeRarity } : {}) },
    )
      .then((page) => {
        // Drop the page if the query/chip changed while it was in flight.
        if (activeQueryRef.current !== searchKey) {
          return;
        }
        setResults((previous) => {
          const seen = new Set(previous.map((item) => item.id));
          return [...previous, ...page.cards.filter((card) => !seen.has(card.id))];
        });
        setHasMore(page.hasMore);
        setIsLoadingMore(false);
      })
      .catch(() => {
        if (activeQueryRef.current !== searchKey) {
          return;
        }
        // Stop paginating on error; the loaded results stay visible.
        setHasMore(false);
        setIsLoadingMore(false);
      });
  }, [query, activeRarity, game, isLoading, isLoadingMore, hasMore, results.length, spotlightRepository]);

  // Recomputed per results change (cheap: it short-circuits on the second
  // distinct game), so a "load more" page that brings in a second game turns
  // the tags on for the whole list rather than only the new rows.
  const showGameTags = resultsSpanMultipleGames(results);

  const renderBody = () => {
    // Search mode: the box has a real query, so show card matches / states.
    if (hasActiveQuery) {
      if (isLoading && results.length === 0) {
        return (
          <View style={styles.bodyStateWrap}>
            <StateCard
              centered
              loading
              message="Looking up matching cards and inventory quantities."
              style={styles.stateCard}
              title="Searching catalog"
            />
          </View>
        );
      }
      if (errorMessage) {
        return (
          <View style={styles.bodyStateWrap}>
            <StateCard
              actionLabel="Retry"
              actionTestID="catalog-retry"
              centered
              message={errorMessage}
              onActionPress={() => setSearchRevision((value) => value + 1)}
              style={styles.stateCard}
              title="Search unavailable"
            />
          </View>
        );
      }
      if (hasSearched && results.length === 0) {
        return (
          <View style={styles.bodyStateWrap}>
            <StateCard
              centered
              message="Try a shorter query, a different set name, or just the collector number."
              style={styles.stateCard}
              title="No matching cards"
            />
          </View>
        );
      }
      if (hasVisibleResults) {
        return (
          <FlatList
            contentContainerStyle={styles.resultsListContent}
            data={chunkResultRows(results)}
            key="results"
            keyExtractor={(row) => row[0].id}
            keyboardShouldPersistTaps="handled"
            ListFooterComponent={isLoadingMore ? (
              <View style={styles.loadMoreFooter} testID="catalog-load-more-spinner">
                <ActivityIndicator color={colors.gray400} />
              </View>
            ) : null}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            testID="catalog-results-list"
            renderItem={({ item: row }) => (
              <View style={styles.gridRow}>
                {row.map((result) => (
                  <SearchResultTile
                    key={result.id}
                    onPress={() => {
                      // Same guard the old row's `disabled` gave: the tile just
                      // tapped ignores re-taps until navigation settles.
                      if (openingResultId === result.id) {
                        return;
                      }
                      openResult(result);
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
          />
        );
      }
      return null;
    }

    // Browse mode (empty box): show the expansions grid so users can drill in.
    if (!browseEnabled) {
      return null;
    }
    if (isLoadingExpansions && expansions.length === 0) {
      return (
        <View style={styles.bodyStateWrap}>
          <StateCard centered loading message="Loading expansions from your card library." style={styles.stateCard} title="Loading sets" />
        </View>
      );
    }
    if (expansionError) {
      return (
        <View style={styles.bodyStateWrap}>
          <StateCard centered message={expansionError} style={styles.stateCard} title="Could not load sets" />
        </View>
      );
    }
    if (hasLoadedExpansions && expansions.length === 0) {
      return (
        <View style={styles.bodyStateWrap}>
          <StateCard centered message="No expansions are loaded yet. Sync the catalog and try again." style={styles.stateCard} title="No sets available" />
        </View>
      );
    }
    return (
      <FlatList
        contentContainerStyle={styles.expansionListContent}
        data={expansions}
        key="browse"
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        numColumns={2}
        testID="catalog-expansion-grid"
        renderItem={({ item }) => (
          <ExpansionCell
            expansion={item}
            onPress={() => onSelectExpansion?.(item)}
            testID={`catalog-expansion-${item.id}`}
          />
        )}
        showsVerticalScrollIndicator={false}
        style={styles.body}
      />
    );
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.searchScreen, { backgroundColor: colors.gray0 }]}
    >
      <View style={styles.fixedHeader}>
        {/*
          This layout used to be hand-rolled here, and the follow lists drew the
          same kind of header a different way (`ScreenHeader`, back button
          inline beside the title). Both come from the primitive now, so they
          cannot drift apart again.
        */}
        <ScreenHeader
          accessoryTestID="catalog-header-back-row"
          layout="stacked"
          leftAccessory={
            <ChromeBackButton
              onPress={onClose}
              style={styles.closeButton}
              testID="catalog-close"
            />
          }
          testID="catalog-header"
          title="Search Cards"
        />

        <SearchField
          ref={searchFieldRef}
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={[
            styles.searchField,
            {
              backgroundColor: theme.colors.surface,
            },
          ]}
          onChangeText={setQuery}
          placeholder="Search by name, set, or number"
          returnKeyType="search"
          value={query}
        />

      </View>

        {/* Rarity chips (same PillButton tone="filter" pattern as the
            Collection filter row). Single-select; tapping the active chip
            clears it. A chip alone searches with no text (browse-by-rarity).
            They used to be hidden whenever the People tab was showing; with
            that tab gone they are simply always present. */}
        <ScrollView
          contentContainerStyle={styles.rarityChipRow}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.rarityChipScroller}
          testID="catalog-rarity-chip-row"
        >
          {RARITY_FILTER_BUCKETS.map((key) => (
            <PillButton
              key={key}
              label={RARITY_BUCKET_LABELS[key]}
              onPress={() => setActiveRarity((current) => (current === key ? null : key))}
              selected={activeRarity === key}
              testID={`catalog-rarity-chip-${key}`}
              tone="filter"
            />
          ))}
        </ScrollView>

      {renderBody()}

      {/* Here rather than at the app root: this screen is a `fullScreenModal`,
          so on iOS a root-hosted toast draws behind it. */}
      <Toast
        message={addedNotice ?? ''}
        onDismiss={() => setAddedNotice(null)}
        /*
          `bottom` carries the inset itself: Yoga's web-conformant absolute
          layout (RN 0.81) ignores the parent SafeAreaView's padding, so a bare
          `bottom: 24` measured from the true screen edge and Android's system
          navigation bar sat on top of the toast.
        */
        style={[styles.addedToast, { bottom: insets.bottom + 24 }]}
        testID="catalog-added-toast"
        visible={addedNotice !== null}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  bodyStateWrap: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  closeButton: {
    flexShrink: 0,
  },
  expansionListContent: {
    paddingBottom: 48,
    paddingHorizontal: 8,
    // The filter row above pays the whole 16 gap; anything here makes it 20.
    paddingTop: 0,
  },
  fixedHeader: {
    gap: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  gridCell: {
    flex: 1,
  },
  gridRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: 12,
  },
  resultsListContent: {
    gap: 12,
    paddingBottom: 48,
    paddingHorizontal: 16,
    // Matches the expansions grid — they share this slot, so differing top
    // padding would shift the filter row as you type.
    paddingTop: 0,
  },
  loadMoreFooter: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  // `Toast` is unpositioned by design; without this it sits in normal flow and
  // runs edge to edge. 16 matches the card detail toast.
  addedToast: {
    // `bottom` is inline — it needs the safe-area inset (see the render note).
    left: 16,
    position: 'absolute',
    right: 16,
  },
  rarityChipScroller: {
    // LOAD-BEARING: RN's horizontal ScrollView defaults to `flexGrow: 1`, which
    // in this `flex: 1` column takes all leftover height and stretches the chips
    // to ~700pt tall.
    flexGrow: 0,
  },
  rarityChipRow: {
    // Belt and braces with `flexGrow: 0` — a chip is sized by its own padding,
    // never by the row.
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingLeft: 16,
    paddingRight: 16,
    paddingVertical: 16,
  },
  searchField: {
  },
  searchScreen: {
    flex: 1,
  },
  stateCard: {
    gap: 16,
    paddingVertical: 24,
  },
});

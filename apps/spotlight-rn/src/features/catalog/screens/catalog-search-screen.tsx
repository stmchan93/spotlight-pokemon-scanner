import { useCallback, useEffect, useRef, useState } from 'react';
import {
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
  RARITY_BUCKET_LABELS,
  RARITY_FILTER_BUCKETS,
  type CardGame,
  type CatalogSearchResult,
  type RarityFilterBucket,
} from '@spotlight/api-client';
import {
  PillButton,
  ScreenHeader,
  SearchField,
  StateCard,
  Toast,
  colors,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { consumeCardAddedNotice } from '@/features/cards/card-added-notice';
import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  CatalogResultsGrid,
  resultsSpanMultipleGames,
} from '@/features/catalog/components/catalog-results-grid';
import { GameMosaicTile } from '@/features/catalog/components/game-mosaic-tile';
import { useCatalogCardSearch } from '@/features/catalog/hooks/use-catalog-card-search';
import { useGameExpansions } from '@/features/catalog/hooks/use-game-expansions';
import { capturePostHogEvent } from '@/lib/observability/posthog';

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
  /** A game was picked in the browse grid — the caller pushes its set list. */
  onSelectGame?: (game: CardGame) => void;
};

export function CatalogSearchScreen({
  initialQuery = '',
  game = DEFAULT_CARD_GAME,
  onClose,
  onOpenCard,
  onSelectGame,
}: CatalogSearchScreenProps) {
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();

  // Single-select rarity chip; tap again to clear. Sent to the backend as the
  // `rarityBucket` search param (a chip alone is a valid browse-by-rarity).
  const [activeRarity, setActiveRarity] = useState<RarityFilterBucket | null>(null);
  /*
    EVERY GAME. Typed queries were scoped to the SCANNER's lane, so searching
    "Darkrai" with the lane on One Piece returned "No matching cards" — with
    nothing on screen saying a filter was applied. A typed name is the user
    naming the card; the lane is about what the camera is pointed at. `game`
    still scopes the BROWSE grid below, where picking a set by game is the
    whole point, and the per-game set list runs the same search scoped to
    itself.
  */
  const search = useCatalogCardSearch({
    initialQuery,
    rarityBucket: activeRarity,
    scope: 'all',
  });
  const { query, setQuery, results } = search;
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
    }, [setQuery]),
  );
  const openingResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
    BROWSE: A GAME GRID. Picking one PUSHES that game's sets.

    The grid used to list ONE game's sets — whichever the scanner lane was
    pointed at — so browsing silently hid every other game's catalog with
    nothing on screen saying so. It is also no longer a list you can scan: five
    games carry 215 sets today and production alone holds 450 Pokémon sets.

    The sets are a ROUTE rather than a second level of this screen's state, so
    the platform's back-swipe returns to the grid instead of popping the whole
    search sheet.
  */
  const browseEnabled = Boolean(onSelectGame);
  const {
    byGame,
    error: expansionError,
    games: browsableGames,
    hasLoaded: hasLoadedExpansions,
    isLoading: isLoadingExpansions,
  } = useGameExpansions(browseEnabled);

  useEffect(() => {
    return () => {
      if (openingResetTimerRef.current) {
        clearTimeout(openingResetTimerRef.current);
      }
    };
  }, []);

  const { errorMessage, hasActiveQuery, hasSearched, isLoading, isLoadingMore, loadMore } = search;
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
              onActionPress={search.retry}
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
          <CatalogResultsGrid
            isLoadingMore={isLoadingMore}
            onEndReached={loadMore}
            onOpenResult={openResult}
            openingResultId={openingResultId}
            results={results}
            showGameTags={showGameTags}
          />
        );
      }
      return null;
    }

    // Browse mode (empty box): show the expansions grid so users can drill in.
    if (!browseEnabled) {
      return null;
    }
    if (isLoadingExpansions && !hasLoadedExpansions) {
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
    if (hasLoadedExpansions && browsableGames.length === 0) {
      return (
        <View style={styles.bodyStateWrap}>
          <StateCard centered message="No expansions are loaded yet. Sync the catalog and try again." style={styles.stateCard} title="No sets available" />
        </View>
      );
    }

    return (
      <FlatList
        contentContainerStyle={styles.expansionListContent}
        data={browsableGames}
        key="browse-games"
        keyExtractor={(item) => item}
        keyboardShouldPersistTaps="handled"
        numColumns={2}
        testID="catalog-game-grid"
        renderItem={({ item }) => (
          <GameMosaicTile
            expansions={byGame[item] ?? []}
            game={item}
            onPress={() => onSelectGame?.(item)}
            setCount={byGame[item]?.length ?? 0}
            testID={`catalog-game-${item}`}
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

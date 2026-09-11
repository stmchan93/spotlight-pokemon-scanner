import { useCallback, useRef, useState } from 'react';
import { FlatList, Keyboard, StyleSheet, type TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  gameDisplayName,
  type CardGame,
  type CatalogSearchResult,
  type ExpansionRecord,
} from '@spotlight/api-client';
import { SearchField, StateCard, Text, colors, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { CatalogResultsGrid } from '@/features/catalog/components/catalog-results-grid';
import { ExpansionCell } from '@/features/catalog/components/expansion-cell';
import { useCatalogCardSearch } from '@/features/catalog/hooks/use-catalog-card-search';
import { useGameExpansions } from '@/features/catalog/hooks/use-game-expansions';
import { capturePostHogEvent } from '@/lib/observability/posthog';

type GameSetsScreenProps = {
  game: CardGame;
  onClose: () => void;
  onSelectExpansion: (expansion: ExpansionRecord, game: CardGame) => void;
  onOpenCard: (result: CatalogSearchResult) => void;
};

/**
 * One game's sets, newest first — with the search box still on it.
 *
 * A ROUTE, not a level inside the browse screen. Holding the set list as screen
 * state meant a right-swipe popped the whole search sheet instead of going back
 * to the game grid (user, 2026-09-10). Pushing it makes the platform's back
 * gesture do the obvious thing for free, and the header back agrees with it.
 *
 * THE SEARCH FOLLOWS YOU DOWN. It was taken off this screen on the grounds that
 * the screen above already had one, which meant the only way to look a card up
 * from here was to go back a level first (user, 2026-09-10). It is the same
 * field, scoped to THIS game: the game is on screen, in the title, so a query
 * typed here is asking about Pokémon or Lorcana specifically and answers from
 * every game would be noise. Set names are searchable, so "obsidian flames"
 * still finds the set's cards.
 *
 * NO LANGUAGE TABS. The list is chronological, and a Japanese set sits wherever
 * its release date puts it.
 */
export function GameSetsScreen({
  game,
  onClose,
  onOpenCard,
  onSelectExpansion,
}: GameSetsScreenProps) {
  const theme = useSpotlightTheme();
  const { byGame, error, hasLoaded, isLoading } = useGameExpansions();
  const search = useCatalogCardSearch({ scope: game });
  // Blurred when a result opens, so no focus survives to be restored when the
  // card page pops back to this screen.
  const searchFieldRef = useRef<TextInput>(null);
  const [openingResultId, setOpeningResultId] = useState<string | null>(null);

  // The backend already returns `release_date DESC NULLS LAST, name ASC`, which
  // IS newest-first; the list renders that order verbatim.
  const expansions = byGame[game] ?? [];

  const openResult = useCallback(
    (result: CatalogSearchResult) => {
      capturePostHogEvent('catalog_search_result_opened', {
        has_rarity_filter: false,
        result_count: search.results.length,
        scope: game,
      });
      searchFieldRef.current?.blur();
      Keyboard.dismiss();
      setOpeningResultId(result.id);
      onOpenCard(result);
    },
    [game, onOpenCard, search.results.length],
  );

  const renderSetsState = () => {
    if (isLoading && !hasLoaded) {
      return (
        <StateCard
          centered
          loading
          message="Loading expansions from your card library."
          style={styles.stateCard}
          title="Loading sets"
        />
      );
    }
    if (error) {
      return <StateCard centered message={error} style={styles.stateCard} title="Could not load sets" />;
    }
    if (hasLoaded && expansions.length === 0) {
      return (
        <StateCard
          centered
          message="No expansions are loaded yet. Sync the catalog and try again."
          style={styles.stateCard}
          title="No sets available"
        />
      );
    }
    return null;
  };

  const renderSearchState = () => {
    if (search.isLoading && search.results.length === 0) {
      return (
        <StateCard
          centered
          loading
          message="Looking up matching cards and inventory quantities."
          style={styles.stateCard}
          title="Searching catalog"
        />
      );
    }
    if (search.errorMessage) {
      return (
        <StateCard
          actionLabel="Retry"
          actionTestID="game-sets-search-retry"
          centered
          message={search.errorMessage}
          onActionPress={search.retry}
          style={styles.stateCard}
          title="Search unavailable"
        />
      );
    }
    if (search.hasSearched && search.results.length === 0) {
      return (
        <StateCard
          centered
          message={`Nothing in ${gameDisplayName(game)} matched. Try a shorter query or just the collector number.`}
          style={styles.stateCard}
          title="No matching cards"
        />
      );
    }
    return null;
  };

  /*
    THE HEADER IS FIXED, and the body below it is what swaps.

    It used to ride along as the set grid's `ListHeaderComponent` and move into
    a plain `View` once a query went live. React reads those as two different
    positions, so the search field UNMOUNTED AND REMOUNTED the moment the query
    reached two characters — dropping first responder mid-word. Typing "luffy"
    searched "lu" and swallowed the rest (user, 2026-09-10). Nothing that holds
    keyboard focus may sit in a subtree that a state change replaces.
  */
  const body = () => {
    if (search.hasActiveQuery) {
      // Only once there is something to show — otherwise the grid's empty list
      // would sit under the state card in the header.
      if (search.results.length === 0 || search.errorMessage) {
        return null;
      }
      return (
        <CatalogResultsGrid
          isLoadingMore={search.isLoadingMore}
          onEndReached={search.loadMore}
          onOpenResult={openResult}
          openingResultId={openingResultId}
          results={search.results}
          testID="game-sets-results"
        />
      );
    }
    return (
      <FlatList
        contentContainerStyle={styles.listContent}
        data={expansions}
        key="sets"
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        numColumns={2}
        renderItem={({ item }) => (
          <ExpansionCell
            expansion={item}
            onPress={() => onSelectExpansion(item, game)}
            testID={`game-sets-expansion-${item.id}`}
          />
        )}
        showsVerticalScrollIndicator={false}
        testID="game-sets-grid"
      />
    );
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.screen, { backgroundColor: colors.gray0 }]}
    >
      <View style={styles.contentTop}>
        <View style={styles.header}>
          <ChromeBackButton onPress={onClose} style={styles.closeButton} testID="game-sets-back" />
          <Text style={[theme.typography.display, { color: theme.colors.textPrimary }]}>
            {`${gameDisplayName(game)} Sets`}
          </Text>
        </View>
        <SearchField
          ref={searchFieldRef}
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={{ backgroundColor: theme.colors.surface }}
          onChangeText={search.setQuery}
          placeholder="Search by name, set, or number"
          returnKeyType="search"
          testID="game-sets-search"
          value={search.query}
        />
        {search.hasActiveQuery ? renderSearchState() : renderSetsState()}
      </View>
      {body()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    flexShrink: 0,
  },
  contentTop: {
    gap: 20,
    paddingBottom: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  header: {
    alignItems: 'flex-start',
    gap: 18,
  },
  listContent: {
    paddingBottom: 24,
    paddingHorizontal: 8,
  },
  screen: {
    flex: 1,
  },
  stateCard: {
    gap: 16,
    paddingVertical: 24,
  },
});

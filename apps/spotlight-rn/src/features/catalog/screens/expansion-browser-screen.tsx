import { FlatList, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CardGame } from '@spotlight/api-client';
import { StateCard, Text, colors, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { GameMosaicTile } from '@/features/catalog/components/game-mosaic-tile';
import { useGameExpansions } from '@/features/catalog/hooks/use-game-expansions';

type ExpansionBrowserScreenProps = {
  onClose: () => void;
  /** A game was picked — the caller pushes its set list. */
  onSelectGame: (game: CardGame) => void;
};

/**
 * Browse Sets: a grid of games, each drawn from its own set logos.
 *
 * It used to list ONE game's sets, whichever the scanner lane pointed at, so
 * every other game's catalog was invisible with nothing saying so (user,
 * 2026-09-10). The sets themselves are a pushed route, which keeps this screen
 * to one job and gives the back-swipe its obvious meaning.
 */
export function ExpansionBrowserScreen({ onClose, onSelectGame }: ExpansionBrowserScreenProps) {
  const theme = useSpotlightTheme();
  const { byGame, error, games, hasLoaded, isLoading } = useGameExpansions();

  const renderState = () => {
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
    if (hasLoaded && games.length === 0) {
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

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.screen, { backgroundColor: colors.gray0 }]}
    >
      <FlatList
        ListHeaderComponent={
          <View style={styles.contentTop}>
            <View style={styles.searchHeader}>
              <View style={styles.searchHeaderBackRow}>
                <ChromeBackButton onPress={onClose} style={styles.closeButton} testID="browse-back" />
              </View>
              <Text style={[theme.typography.display, { color: theme.colors.textPrimary }]}>
                Browse Sets
              </Text>
            </View>
            {renderState()}
          </View>
        }
        contentContainerStyle={styles.expansionListContent}
        data={games}
        keyExtractor={(item) => item}
        keyboardShouldPersistTaps="handled"
        numColumns={2}
        renderItem={({ item }) => (
          <GameMosaicTile
            expansions={byGame[item] ?? []}
            game={item}
            onPress={() => onSelectGame(item)}
            setCount={byGame[item]?.length ?? 0}
            testID={`browse-game-${item}`}
          />
        )}
        showsVerticalScrollIndicator={false}
      />
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
  expansionListContent: {
    paddingBottom: 24,
    paddingHorizontal: 8,
  },
  screen: {
    flex: 1,
  },
  searchHeader: {
    alignItems: 'flex-start',
    gap: 18,
  },
  searchHeaderBackRow: {
    alignSelf: 'flex-start',
  },
  stateCard: {
    gap: 16,
    paddingVertical: 24,
  },
});

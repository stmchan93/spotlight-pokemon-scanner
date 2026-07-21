import { useEffect, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ExpansionRecord } from '@spotlight/api-client';
import { SearchField, StateCard, Text, colors, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { ExpansionCell } from '@/features/catalog/components/expansion-cell';
import { useAppServices } from '@/providers/app-providers';

type ExpansionBrowserScreenProps = {
  game?: string;
  onClose: () => void;
  onSelectExpansion: (expansion: ExpansionRecord) => void;
};

export function ExpansionBrowserScreen({ game = 'pokemon', onClose, onSelectExpansion }: ExpansionBrowserScreenProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository } = useAppServices();

  const [expansionQuery, setExpansionQuery] = useState('');
  const [expansions, setExpansions] = useState<ExpansionRecord[]>([]);
  const [isLoadingExpansions, setIsLoadingExpansions] = useState(true);
  const [hasLoadedExpansions, setHasLoadedExpansions] = useState(false);
  const [expansionError, setExpansionError] = useState('');

  useEffect(() => {
    setIsLoadingExpansions(true);
    setExpansionError('');
    void spotlightRepository.listExpansions(game)
      .then((results) => {
        setExpansions(results);
        setHasLoadedExpansions(true);
        setIsLoadingExpansions(false);
      })
      .catch(() => {
        setExpansionError('Could not load expansions. Try again in a moment.');
        setHasLoadedExpansions(true);
        setIsLoadingExpansions(false);
      });
  }, [game, spotlightRepository]);

  const trimmedExpansionQuery = expansionQuery.trim().toLowerCase();
  const filteredExpansions = trimmedExpansionQuery
    ? expansions.filter((e) =>
        e.name.toLowerCase().includes(trimmedExpansionQuery) ||
        (e.series ?? '').toLowerCase().includes(trimmedExpansionQuery)
      )
    : expansions;

  const renderExpansionsState = () => {
    if (isLoadingExpansions) {
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
    if (expansionError) {
      return (
        <StateCard
          centered
          message={expansionError}
          style={styles.stateCard}
          title="Could not load sets"
        />
      );
    }
    if (hasLoadedExpansions && expansions.length === 0) {
      return (
        <StateCard
          centered
          message="No expansions are loaded yet. Sync the catalog and try again."
          style={styles.stateCard}
          title="No sets available"
        />
      );
    }
    if (filteredExpansions.length === 0) {
      return (
        <StateCard
          centered
          message="Try a different search term."
          style={styles.stateCard}
          title="No matching sets"
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
                <ChromeBackButton onPress={onClose} style={styles.closeButton} />
              </View>
              <Text style={[theme.typography.display, { color: theme.colors.textPrimary }]}>
                Browse Sets
              </Text>
            </View>
            <SearchField
              autoCapitalize="none"
              autoCorrect={false}
              containerStyle={[styles.searchField, { backgroundColor: theme.colors.surface }]}
              onChangeText={setExpansionQuery}
              placeholder="Search expansions"
              returnKeyType="search"
              value={expansionQuery}
            />
            {renderExpansionsState()}
          </View>
        }
        contentContainerStyle={styles.expansionListContent}
        data={filteredExpansions}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.id}
        numColumns={2}
        renderItem={({ item }) => (
          <ExpansionCell
            expansion={item}
            onPress={() => onSelectExpansion(item)}
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
  searchField: {
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

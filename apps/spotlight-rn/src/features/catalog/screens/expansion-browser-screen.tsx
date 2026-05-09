import { useEffect, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ExpansionRecord } from '@spotlight/api-client';
import { SearchField, StateCard, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { useAppServices } from '@/providers/app-providers';

type ExpansionBrowserScreenProps = {
  game?: string;
  onClose: () => void;
  onSelectExpansion: (expansion: ExpansionRecord) => void;
};

function ExpansionCell({
  expansion,
  onPress,
}: {
  expansion: ExpansionRecord;
  onPress: () => void;
}) {
  const theme = useSpotlightTheme();
  const [hasImageError, setHasImageError] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.expansionCell, { opacity: pressed ? 0.8 : 1 }]}
    >
      <View
        style={[
          styles.expansionImageFrame,
          {
            backgroundColor: theme.colors.field,
            borderColor: theme.colors.outlineSubtle,
          },
        ]}
      >
        {expansion.imageUrl && !hasImageError ? (
          <Image
            onError={() => setHasImageError(true)}
            resizeMode="contain"
            source={{ uri: expansion.imageUrl }}
            style={styles.expansionImage}
          />
        ) : (
          <Text
            numberOfLines={3}
            style={[styles.expansionImageFallback, theme.typography.caption, { color: theme.colors.textSecondary }]}
          >
            {expansion.name}
          </Text>
        )}
      </View>
      <Text numberOfLines={2} style={[styles.expansionName, theme.typography.body, { color: theme.colors.textPrimary }]}>
        {expansion.name}
      </Text>
      {expansion.releaseDate ? (
        <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {expansion.releaseDate}
        </Text>
      ) : null}
    </Pressable>
  );
}

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
      style={[styles.screen, { backgroundColor: theme.colors.pageLight }]}
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
  expansionCell: {
    alignItems: 'center',
    flex: 1 / 2,
    gap: 6,
    padding: 8,
  },
  expansionImage: {
    height: '100%',
    width: '100%',
  },
  expansionImageFallback: {
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  expansionImageFrame: {
    alignItems: 'center',
    aspectRatio: 16 / 10,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    overflow: 'hidden',
    width: '100%',
  },
  expansionListContent: {
    paddingBottom: 24,
    paddingHorizontal: 8,
  },
  expansionName: {
    textAlign: 'center',
    width: '100%',
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

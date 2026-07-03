import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CatalogSearchResult, ExpansionRecord } from '@spotlight/api-client';
import { SearchField, StateCard, colors, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage, imageCachePolicy } from '@/components/cached-image';
import { ChromeBackButton } from '@/components/chrome-back-button';
import { ExpansionCell } from '@/features/catalog/components/expansion-cell';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { useAppServices } from '@/providers/app-providers';

type CatalogSearchScreenProps = {
  initialQuery?: string;
  /** Game whose expansions populate the browse grid (defaults to pokemon). */
  game?: string;
  onClose: () => void;
  onOpenCard: (result: CatalogSearchResult) => void;
  /**
   * Tap handler for a set in the browse grid. When provided, the empty state
   * shows every expansion (logo + name) so users can drill into one and search
   * within it; typing in the search box still searches all cards globally.
   */
  onSelectExpansion?: (expansion: ExpansionRecord) => void;
};

function resultNumberLabel(result: CatalogSearchResult) {
  return result.cardNumber.startsWith('#') ? result.cardNumber : `#${result.cardNumber}`;
}

function ResultArtwork({
  fallbackTestID,
  imageUrl,
  smallImageUrl,
  title,
}: {
  fallbackTestID: string;
  imageUrl: string;
  smallImageUrl?: string | null;
  title: string;
}) {
  const theme = useSpotlightTheme();
  const [hasImageError, setHasImageError] = useState(false);

  // Prefer the small/thumbnail-resolution image so result rows stay fast on
  // poor connections; fall back to the large url when no small one exists.
  const artworkUri = smallImageUrl ?? imageUrl;

  return (
    <View
      style={[
        styles.resultArtFrame,
        {
          backgroundColor: theme.colors.field,
          borderColor: theme.colors.outlineSubtle,
        },
      ]}
    >
      {!hasImageError && artworkUri ? (
        <CachedImage
          cachePolicy={imageCachePolicy.thumbnail}
          contentFit="contain"
          onError={() => setHasImageError(true)}
          style={styles.resultArt}
          uri={artworkUri}
        />
      ) : (
        <Text
          numberOfLines={2}
          testID={fallbackTestID}
          style={[styles.resultArtFallback, theme.typography.caption, { color: theme.colors.textSecondary }]}
        >
          {title}
        </Text>
      )}
    </View>
  );
}

function SearchResultRow({
  result,
  isOpening,
  onPress,
}: {
  result: CatalogSearchResult;
  isOpening: boolean;
  onPress: () => void;
}) {
  const theme = useSpotlightTheme();
  const subtitle = result.subtitle?.trim() ? result.subtitle : result.setName;

  return (
    <View testID={`catalog-result-${result.id}`}>
      <Pressable
        accessibilityRole="button"
        disabled={isOpening}
        onPress={onPress}
        style={({ pressed }) => ({ opacity: isOpening ? 0.82 : pressed ? 0.94 : 1 })}
        testID={`catalog-result-smoke-${result.cardId}`}
      >
        <View
          style={[
            styles.resultRow,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.outlineSubtle,
            },
          ]}
        >
          <ResultArtwork
            fallbackTestID={`catalog-artwork-fallback-${result.id}`}
            imageUrl={result.imageUrl}
            smallImageUrl={result.smallImageUrl}
            title={result.name}
          />

          <View style={styles.resultCopy}>
            <View style={styles.resultHeader}>
              <Text numberOfLines={2} style={[styles.resultTitle, { color: theme.colors.textPrimary }]}>
                {result.name}
              </Text>

              {result.ownedQuantity ? (
                <View style={[styles.ownedBadge, { backgroundColor: theme.colors.surfaceMuted }]}>
                  <Text style={[theme.typography.caption, { color: theme.colors.textPrimary }]}>
                    Owned {result.ownedQuantity}
                  </Text>
                </View>
              ) : null}
            </View>

            <Text numberOfLines={2} style={[styles.resultSubtitle, { color: theme.colors.textSecondary }]}>
              {subtitle}
            </Text>

            <View style={styles.resultMetaRow}>
              <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                {resultNumberLabel(result)}
              </Text>

              {result.marketPrice != null ? (
                <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                  {formatCurrency(result.marketPrice, result.currencyCode ?? 'USD')}
                </Text>
              ) : null}
            </View>
          </View>

          {isOpening ? (
            <ActivityIndicator color={theme.colors.brand} style={styles.resultActivity} />
          ) : (
            <Text style={[styles.resultChevron, { color: theme.colors.textSecondary }]}>›</Text>
          )}
        </View>
      </Pressable>
    </View>
  );
}

export function CatalogSearchScreen({
  initialQuery = '',
  game = 'pokemon',
  onClose,
  onOpenCard,
  onSelectExpansion,
}: CatalogSearchScreenProps) {
  const theme = useSpotlightTheme();
  const { spotlightRepository } = useAppServices();

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [searchRevision, setSearchRevision] = useState(0);
  const [openingResultId, setOpeningResultId] = useState<string | null>(null);
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
    if (trimmed.length < 2) {
      setResults([]);
      setHasSearched(false);
      setIsLoading(false);
      setErrorMessage('');
      setOpeningResultId(null);
      return;
    }

    setHasSearched(false);
    setErrorMessage('');

    let isCancelled = false;
    const timeout = setTimeout(() => {
      setIsLoading(true);

      void spotlightRepository.searchCatalogCards(trimmed, 50)
        .then((nextResults) => {
          if (isCancelled) {
            return;
          }

          setResults(nextResults);
          setHasSearched(true);
          setIsLoading(false);
          setOpeningResultId(null);
        })
        .catch(() => {
          if (isCancelled) {
            return;
          }

          setResults([]);
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
  }, [query, searchRevision, spotlightRepository]);

  const trimmedQuery = query.trim();
  const hasActiveQuery = trimmedQuery.length >= 2;
  const hasVisibleResults = hasActiveQuery && !errorMessage && results.length > 0;

  const openResult = (result: CatalogSearchResult) => {
    if (openingResetTimerRef.current) {
      clearTimeout(openingResetTimerRef.current);
    }
    setOpeningResultId(result.id);
    onOpenCard(result);
    openingResetTimerRef.current = setTimeout(() => {
      setOpeningResultId((current) => (current === result.id ? null : current));
      openingResetTimerRef.current = null;
    }, 350);
  };

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
            data={results}
            key="results"
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <SearchResultRow
                isOpening={openingResultId === item.id}
                onPress={() => openResult(item)}
                result={item}
              />
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
        <View style={styles.searchHeader} testID="catalog-header">
          <View style={styles.searchHeaderBackRow} testID="catalog-header-back-row">
            <ChromeBackButton
              onPress={onClose}
              style={styles.closeButton}
              testID="catalog-close"
            />
          </View>

          <Text style={theme.typography.display}>Add Card</Text>
        </View>

        <SearchField
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

      {renderBody()}
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
    paddingBottom: 24,
    paddingHorizontal: 8,
    paddingTop: 4,
  },
  fixedHeader: {
    gap: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  ownedBadge: {
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 24,
    paddingHorizontal: 10,
  },
  resultActivity: {
    paddingTop: 4,
  },
  resultArt: {
    height: '100%',
    width: '100%',
  },
  resultArtFallback: {
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  resultArtFrame: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    height: 92,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 64,
  },
  resultChevron: {
    fontSize: 18,
    lineHeight: 18,
    paddingTop: 6,
  },
  resultCopy: {
    flex: 1,
    gap: 8,
  },
  resultHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  resultMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  resultRow: {
    alignItems: 'flex-start',
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  resultsListContent: {
    gap: 12,
    paddingBottom: 24,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
  resultSubtitle: {
    fontSize: 15,
    lineHeight: 20,
  },
  resultTitle: {
    flex: 1,
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 22,
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
  searchScreen: {
    flex: 1,
  },
  stateCard: {
    gap: 16,
    paddingVertical: 24,
  },
});

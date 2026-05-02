import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { SearchField, StateCard, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { useAppServices } from '@/providers/app-providers';

type CatalogSearchScreenProps = {
  initialQuery?: string;
  onClose: () => void;
  onOpenCard: (result: CatalogSearchResult) => void;
};

function resultNumberLabel(result: CatalogSearchResult) {
  return result.cardNumber.startsWith('#') ? result.cardNumber : `#${result.cardNumber}`;
}

function ResultArtwork({
  fallbackTestID,
  imageUrl,
  title,
}: {
  fallbackTestID: string;
  imageUrl: string;
  title: string;
}) {
  const theme = useSpotlightTheme();
  const [hasImageError, setHasImageError] = useState(false);

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
      {!hasImageError && imageUrl ? (
        <Image
          onError={() => setHasImageError(true)}
          source={{ uri: imageUrl }}
          style={styles.resultArt}
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
  onClose,
  onOpenCard,
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

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

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

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.searchScreen, { backgroundColor: theme.colors.pageLight }]}
    >
      <ScrollView
        contentContainerStyle={styles.searchContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
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
          autoFocus
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

        {isLoading && results.length === 0 ? (
          <StateCard
            centered
            loading
            message="Looking up matching cards and inventory quantities."
            style={styles.stateCard}
            title="Searching catalog"
          />
        ) : errorMessage ? (
          <StateCard
            actionLabel="Retry"
            actionTestID="catalog-retry"
            centered
            message={errorMessage}
            onActionPress={() => setSearchRevision((value) => value + 1)}
            style={styles.stateCard}
            title="Search unavailable"
          />
        ) : !hasActiveQuery ? null : hasSearched && results.length === 0 ? (
          <StateCard
            centered
            message="Try a shorter query, a different set name, or just the collector number."
            style={styles.stateCard}
            title="No matching cards"
          />
        ) : hasVisibleResults ? (
          <View style={styles.resultsSection}>
            <View style={styles.resultsList}>
              {results.map((result) => (
                <SearchResultRow
                  key={result.id}
                  isOpening={openingResultId === result.id}
                  onPress={() => openResult(result)}
                  result={result}
                />
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  closeButton: {
    flexShrink: 0,
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
    resizeMode: 'contain',
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
  resultsList: {
    gap: 12,
  },
  resultsSection: {
    gap: 12,
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
  searchContent: {
    gap: 20,
    paddingBottom: 24,
    paddingHorizontal: 16,
    paddingTop: 12,
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

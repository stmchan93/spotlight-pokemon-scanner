import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Eye } from 'iconoir-react-native';
import { useRouter } from 'expo-router';

import type { WatchlistSuggestion } from '@spotlight/api-client';
import {
  AppText,
  Badge,
  Button,
  CardListRow,
  InlineLoader,
  PillButton,
  StateCard,
  radii,
  spacing,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';
import { useGuestGate } from '@/features/auth/use-guest-gate';
import { getCardImageSource } from '@/lib/card-images';
import {
  AnalyticsEvent,
  watchlistKindForCardId,
} from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';

// Illustration only — the user does not watch it. Minimal card-like object so
// the art resolves through the same image helpers as every other card tile.
const EXAMPLE_CARD = {
  cardId: 'base1-4',
  name: 'Charizard',
  setName: 'Base Set',
  imageUrl: 'https://images.pokemontcg.io/base1/4.png',
  largeImageUrl: 'https://images.pokemontcg.io/base1/4_hires.png',
} as const;

const EXAMPLE_ART_WIDTH = 112;
const CARD_ASPECT = 342 / 245;
const WATCH_BADGE_SIZE = 28;

const SUGGESTION_LIMIT = 6;

type SuggestionsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; items: WatchlistSuggestion[] };

type WatchlistEmptyStateProps = {
  /** A suggestion was watched — the screen re-reads its favorites. */
  onWatched: () => void;
};

export function WatchlistEmptyState({ onWatched }: WatchlistEmptyStateProps) {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const { isGuest, openLogin } = useGuestGate();
  const [suggestions, setSuggestions] = useState<SuggestionsState>({ status: 'idle' });
  // Per card: 'pending' while the write is in flight, 'watched' once it lands.
  const [watchState, setWatchState] = useState<Record<string, 'pending' | 'watched'>>({});

  const loadSuggestions = useCallback(async () => {
    setSuggestions({ status: 'loading' });
    capturePostHogEvent(AnalyticsEvent.watchlistSuggestionsRequested);
    try {
      const items = await spotlightRepository.getWatchlistSuggestions(SUGGESTION_LIMIT);
      setSuggestions({ status: 'loaded', items });
    } catch {
      setSuggestions({ status: 'error' });
    }
  }, [spotlightRepository]);

  // Same write as the scanner tray's Watch: the card's main printing.
  const handleWatch = useCallback(async (suggestion: WatchlistSuggestion) => {
    if (isGuest) {
      openLogin();
      return;
    }
    const { cardId } = suggestion;
    setWatchState((current) => ({ ...current, [cardId]: 'pending' }));
    try {
      await spotlightRepository.setCardFavorite(cardId, true);
      setWatchState((current) => ({ ...current, [cardId]: 'watched' }));
      capturePostHogEvent(AnalyticsEvent.watchlistItemAdded, {
        source: 'watchlist_suggestion',
        kind: watchlistKindForCardId(cardId),
        has_printing: false,
      });
      onWatched();
    } catch {
      setWatchState(({ [cardId]: _dropped, ...rest }) => rest);
    }
  }, [isGuest, onWatched, openLogin, spotlightRepository]);

  const openCard = useCallback((cardId: string) => {
    router.push({ pathname: '/cards/[cardId]', params: { cardId } });
  }, [router]);

  return (
    <View
      style={[styles.root, { paddingHorizontal: theme.layout.pageGutter }]}
      testID="wishlist-empty"
    >
      <Pressable
        accessibilityHint="Example card, not on your watchlist"
        accessibilityLabel={`Example: ${EXAMPLE_CARD.name}, ${EXAMPLE_CARD.setName}`}
        accessibilityRole="button"
        onPress={() => openCard(EXAMPLE_CARD.cardId)}
        style={styles.example}
        testID="watchlist-empty-example"
      >
        <View style={[styles.exampleArt, { backgroundColor: theme.colors.field }]}>
          <CachedImage
            accessibilityIgnoresInvertColors
            source={getCardImageSource(EXAMPLE_CARD, 'small')}
            style={StyleSheet.absoluteFill}
            testID="watchlist-empty-example-image"
          />
        </View>
        <Badge label="Example" size="sm" style={styles.exampleTag} testID="watchlist-empty-example-tag" />
        <View
          style={[
            styles.watchBadge,
            { backgroundColor: theme.colors.purple500, borderColor: theme.colors.gray0 },
          ]}
        >
          <Eye color={theme.colors.gray0} height={16} strokeWidth={2} width={16} />
        </View>
        <AppText color="gray900" numberOfLines={1} style={styles.centered} variant="titleSmall">
          {EXAMPLE_CARD.name}
        </AppText>
        <AppText color="gray600" numberOfLines={1} style={styles.centered} variant="label">
          {EXAMPLE_CARD.setName}
        </AppText>
      </Pressable>

      <View style={styles.copy}>
        <AppText color="gray900" style={styles.centered} variant="titleMedium">
          Watch cards you want
        </AppText>
        <AppText color="gray600" style={styles.centered} variant="bodyMedium">
          {"We'll alert you when one's listed under market on eBay or drops in price."}
        </AppText>
      </View>

      <Button
        disabled={suggestions.status === 'loading'}
        label="Suggest cards to watch"
        onPress={() => { void loadSuggestions(); }}
        testID="watchlist-empty-suggest"
      />

      {suggestions.status === 'loading' ? (
        <InlineLoader label="Looking through your scans…" testID="watchlist-suggestions-loading" />
      ) : null}

      {suggestions.status === 'error' ? (
        <StateCard
          actionLabel="Retry"
          actionTestID="watchlist-suggestions-retry"
          actionVariant="secondary"
          message="Try again in a moment."
          onActionPress={() => { void loadSuggestions(); }}
          style={styles.fullWidth}
          testID="watchlist-suggestions-error"
          title="Couldn't load suggestions"
          variant="muted"
        />
      ) : null}

      {suggestions.status === 'loaded' && suggestions.items.length === 0 ? (
        <AppText
          color="gray600"
          style={styles.centered}
          testID="watchlist-suggestions-empty"
          variant="body"
        >
          {"Scan a few cards and we'll suggest some here."}
        </AppText>
      ) : null}

      {suggestions.status === 'loaded' && suggestions.items.length > 0 ? (
        <View style={styles.fullWidth} testID="watchlist-suggestions">
          {suggestions.items.map((suggestion, index) => {
            const state = watchState[suggestion.cardId];
            return (
              <View key={suggestion.cardId} style={styles.suggestionRow}>
                <View style={styles.suggestionCard}>
                  <CardListRow
                    cardNumber={suggestion.cardNumber}
                    currencyCode={suggestion.currencyCode}
                    firstInSection={index === 0}
                    imageUrl={getCardImageSource(suggestion, 'small')?.uri ?? null}
                    marketPrice={suggestion.marketPrice}
                    name={suggestion.name}
                    onPress={() => openCard(suggestion.cardId)}
                    quantity={0}
                    setName={suggestion.setName}
                    showQuantity={false}
                    testID={`watchlist-suggestion-${suggestion.cardId}`}
                  />
                </View>
                <PillButton
                  label={state === 'watched' ? 'Watching' : 'Watch'}
                  onPress={state ? undefined : () => { void handleWatch(suggestion); }}
                  selected={state === 'watched'}
                  testID={`watchlist-suggestion-watch-${suggestion.cardId}`}
                  tone="filter"
                />
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    textAlign: 'center',
  },
  copy: {
    gap: spacing.xxs,
  },
  example: {
    alignItems: 'center',
    gap: spacing.xxxs,
    width: EXAMPLE_ART_WIDTH,
  },
  exampleArt: {
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    height: EXAMPLE_ART_WIDTH * CARD_ASPECT,
    marginBottom: spacing.xxs,
    overflow: 'hidden',
    width: EXAMPLE_ART_WIDTH,
  },
  exampleTag: {
    left: spacing.xxxs,
    position: 'absolute',
    top: spacing.xxxs,
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
  root: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
  },
  suggestionCard: {
    flex: 1,
  },
  suggestionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xxs,
  },
  watchBadge: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    borderWidth: 2,
    height: WATCH_BADGE_SIZE,
    justifyContent: 'center',
    position: 'absolute',
    right: -spacing.xxxs,
    // Straddles the art's bottom-right corner.
    top: EXAMPLE_ART_WIDTH * CARD_ASPECT - WATCH_BADGE_SIZE + spacing.xxxs,
    width: WATCH_BADGE_SIZE,
  },
});

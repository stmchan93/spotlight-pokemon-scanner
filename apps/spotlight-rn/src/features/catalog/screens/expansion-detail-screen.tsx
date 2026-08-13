import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CatalogSearchResult } from '@spotlight/api-client';
import { SearchField, StateCard, Text, Toast, colors, useSpotlightTheme } from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import { consumeCardAddedNotice } from '@/features/cards/card-added-notice';
import { useAppServices } from '@/providers/app-providers';

type ExpansionDetailScreenProps = {
  expansionId: string;
  expansionName: string;
  onClose: () => void;
  onOpenCard: (result: CatalogSearchResult) => void;
};

function CardCell({
  result,
  isOpening,
  onPress,
}: {
  result: CatalogSearchResult;
  isOpening: boolean;
  onPress: () => void;
}) {
  const theme = useSpotlightTheme();
  const [hasImageError, setHasImageError] = useState(false);

  return (
    <Pressable
      accessibilityRole="button"
      disabled={isOpening}
      onPress={onPress}
      style={({ pressed }) => [styles.cardCell, { opacity: isOpening ? 0.82 : pressed ? 0.88 : 1 }]}
    >
      <View
        style={[
          styles.cardImageFrame,
          {
            backgroundColor: theme.colors.field,
            borderColor: theme.colors.outlineSubtle,
          },
        ]}
      >
        {result.imageUrl && !hasImageError ? (
          <Image
            onError={() => setHasImageError(true)}
            resizeMode="contain"
            source={{ uri: result.imageUrl }}
            style={styles.cardImage}
          />
        ) : (
          <Text
            numberOfLines={3}
            style={[styles.cardImageFallback, theme.typography.caption, { color: theme.colors.textSecondary }]}
          >
            {result.name}
          </Text>
        )}
        {isOpening ? (
          <View style={styles.cardOpeningOverlay}>
            <ActivityIndicator color={theme.colors.brand} size="small" />
          </View>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.cardName, theme.typography.caption, { color: theme.colors.textPrimary }]}>
        {result.name}
      </Text>
      <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
        {result.cardNumber}
      </Text>
    </Pressable>
  );
}

export function ExpansionDetailScreen({ expansionId, expansionName, onClose, onOpenCard }: ExpansionDetailScreenProps) {
  // Cards are added from inside a set too, so the confirmation has to land here
  // as well as on the search screen. On FOCUS — this screen stays mounted under
  // the card page.
  const [addedNotice, setAddedNotice] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      const notice = consumeCardAddedNotice();
      if (notice) {
        setAddedNotice(notice);
      }
    }, []),
  );
  const theme = useSpotlightTheme();
  const insets = useSafeAreaInsets();
  const { spotlightRepository } = useAppServices();

  const [cardQuery, setCardQuery] = useState('');
  const [cards, setCards] = useState<CatalogSearchResult[]>([]);
  const [isLoadingCards, setIsLoadingCards] = useState(true);
  const [openingResultId, setOpeningResultId] = useState<string | null>(null);
  const openingResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (openingResetTimerRef.current) {
        clearTimeout(openingResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setIsLoadingCards(true);
    setCards([]);

    const trimmedQuery = cardQuery.trim();
    let isCancelled = false;

    const timeout = setTimeout(() => {
      void spotlightRepository.listCardsInExpansion(expansionId, trimmedQuery, 60)
        .then((results) => {
          if (!isCancelled) {
            setCards(results);
            setIsLoadingCards(false);
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setCards([]);
            setIsLoadingCards(false);
          }
        });
    }, trimmedQuery.length >= 1 ? 275 : 0);

    return () => {
      isCancelled = true;
      clearTimeout(timeout);
    };
  }, [expansionId, cardQuery, spotlightRepository]);

  const openCard = useCallback((result: CatalogSearchResult) => {
    if (openingResetTimerRef.current) {
      clearTimeout(openingResetTimerRef.current);
    }
    setOpeningResultId(result.id);
    onOpenCard(result);
    openingResetTimerRef.current = setTimeout(() => {
      setOpeningResultId((current) => (current === result.id ? null : current));
      openingResetTimerRef.current = null;
    }, 350);
  }, [onOpenCard]);

  const renderCardsState = () => {
    if (isLoadingCards && cards.length === 0) {
      return (
        <StateCard
          centered
          loading
          message="Loading cards from this set."
          style={styles.stateCard}
          title="Loading"
        />
      );
    }
    if (cards.length === 0) {
      return (
        <StateCard
          centered
          message={cardQuery.trim().length >= 1 ? 'Try a different name or number.' : 'No cards found in this set yet.'}
          style={styles.stateCard}
          title="No cards"
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
              <Text numberOfLines={2} style={[theme.typography.display, { color: theme.colors.textPrimary }]}>
                {expansionName}
              </Text>
            </View>
            <SearchField
              autoCapitalize="none"
              autoCorrect={false}
              containerStyle={[styles.searchField, { backgroundColor: theme.colors.surface }]}
              onChangeText={setCardQuery}
              placeholder="Search by name or number"
              returnKeyType="search"
              value={cardQuery}
            />
            {renderCardsState()}
          </View>
        }
        contentContainerStyle={styles.cardListContent}
        data={cards}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.id}
        numColumns={3}
        renderItem={({ item }) => (
          <CardCell
            isOpening={openingResultId === item.id}
            onPress={() => openCard(item)}
            result={item}
          />
        )}
        showsVerticalScrollIndicator={false}
      />

      <Toast
        message={addedNotice ?? ''}
        onDismiss={() => setAddedNotice(null)}
        // Inset carried on `bottom` itself — Yoga's web-conformant absolute
        // layout ignores the SafeAreaView's padding (same note as the catalog
        // search toast), so without it Android's nav bar covered the toast.
        style={[styles.addedToast, { bottom: insets.bottom + 24 }]}
        testID="expansion-added-toast"
        visible={addedNotice !== null}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // `Toast` is unpositioned by design — 16 in from each edge, like card detail.
  addedToast: {
    // `bottom` is inline — it needs the safe-area inset (see the render note).
    left: 16,
    position: 'absolute',
    right: 16,
  },
  cardCell: {
    alignItems: 'center',
    flex: 1 / 3,
    gap: 4,
    padding: 6,
  },
  cardImage: {
    height: '100%',
    resizeMode: 'contain',
    width: '100%',
  },
  cardImageFallback: {
    paddingHorizontal: 4,
    textAlign: 'center',
  },
  cardImageFrame: {
    alignItems: 'center',
    aspectRatio: 0.72,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    overflow: 'hidden',
    width: '100%',
  },
  cardListContent: {
    paddingBottom: 24,
    paddingHorizontal: 10,
  },
  cardName: {
    textAlign: 'center',
    width: '100%',
  },
  cardOpeningOverlay: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  closeButton: {
    flexShrink: 0,
  },
  contentTop: {
    gap: 20,
    paddingBottom: 20,
    paddingHorizontal: 16,
    paddingTop: 12,
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

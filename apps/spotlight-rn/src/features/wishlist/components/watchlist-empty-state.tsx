import { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Eye } from 'iconoir-react-native';
import { useRouter } from 'expo-router';

import { AppText, Badge, radii, spacing, useSpotlightTheme } from '@spotlight/design-system';

import { CachedImage } from '@/components/cached-image';
import { getCardImageSource } from '@/lib/card-images';

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

export function WatchlistEmptyState() {
  const theme = useSpotlightTheme();
  const router = useRouter();

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
  root: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
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

import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AppText, CardRailTile, spacing } from '@spotlight/design-system';
import type { SimilarCard, SimilarCards, SpotlightRepository } from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

type CardSimilarSectionProps = {
  cardId: string;
  /**
   * Fetch only once this is true. The PDP passes "main detail has landed" so
   * this read never competes with the page's first paint.
   */
  enabled: boolean;
  repository: Pick<SpotlightRepository, 'fetchSimilarCards'>;
  onPressCard: (card: SimilarCard) => void;
  testID?: string;
};

function priceLabel(card: SimilarCard): string | null {
  return card.priceNow == null ? null : formatCurrency(card.priceNow, card.currencyCode);
}

function subtitle(card: SimilarCard): string {
  const parts = [card.language && card.language !== 'English' ? card.language : null, card.setName, card.number];
  return parts.filter(Boolean).join(' · ');
}

/**
 * "More like this" (docs/meta-feed-mockup/v2/SimilarV7): up to three rows from
 * the art-embedding neighbours — the same-set pair, other cards of the same
 * base name, and look-alikes that cost less. Empty rows hide; the whole
 * section hides when every row is empty, the feature is off (null), or the
 * request fails.
 */
export function CardSimilarSection({ cardId, enabled, repository, onPressCard, testID }: CardSimilarSectionProps) {
  const [similar, setSimilar] = useState<SimilarCards | null>(null);

  useEffect(() => {
    setSimilar(null);
    if (!enabled || !cardId) {
      return undefined;
    }
    let cancelled = false;
    repository
      .fetchSimilarCards(cardId)
      .then((payload) => {
        if (!cancelled) {
          setSimilar(payload);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSimilar(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, enabled, repository]);

  if (!similar || similar.cardId !== cardId) {
    return null;
  }
  const { goesWith, sameName, sameLookCheaper } = similar;
  if (!goesWith && sameName.length === 0 && sameLookCheaper.length === 0) {
    return null;
  }
  const baseName = similar.baseName?.trim();

  const renderRail = (key: string, title: string, caption: string, cards: SimilarCard[]) =>
    cards.length === 0 ? null : (
      <View style={styles.row} testID={testID ? `${testID}-${key}` : undefined}>
        <View style={styles.rowHeader}>
          <AppText color="gray900" variant="titleSmall">{title}</AppText>
          <AppText color="gray600" variant="captionMedium">{caption}</AppText>
        </View>
        <ScrollView
          contentContainerStyle={styles.railContent}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.rail}
        >
          {cards.map((card) => (
            <CardRailTile
              imageUrl={card.imageUrl}
              key={card.cardId}
              name={card.name}
              onPress={() => onPressCard(card)}
              priceLabel={priceLabel(card)}
              subtitle={subtitle(card)}
              testID={testID ? `${testID}-${key}-${card.cardId}` : undefined}
            />
          ))}
        </ScrollView>
      </View>
    );

  return (
    <View style={styles.container} testID={testID}>
      <AppText color="gray900" variant="titleMedium">More like this</AppText>

      {goesWith ? (
        <View style={styles.row} testID={testID ? `${testID}-goes-with` : undefined}>
          <View style={styles.rowHeader}>
            <AppText color="gray900" variant="titleSmall">Goes with</AppText>
            <AppText color="gray600" variant="captionMedium">Its matching pair from the same set</AppText>
          </View>
          <CardRailTile
            accentLabel="Complete the pair"
            imageUrl={goesWith.imageUrl}
            layout="feature"
            name={goesWith.name}
            onPress={() => onPressCard(goesWith)}
            priceLabel={priceLabel(goesWith)}
            subtitle={[goesWith.setName, goesWith.number].filter(Boolean).join(' · ')}
            testID={testID ? `${testID}-goes-with-${goesWith.cardId}` : undefined}
          />
        </View>
      ) : null}

      {renderRail(
        'same-name',
        baseName ? `Other ${baseName} cards` : 'Other printings',
        'Other sets and languages',
        sameName,
      )}
      {renderRail('cheaper', 'Same look, lower price', 'Similar art for less', sameLookCheaper)}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.md,
  },
  row: {
    gap: spacing.xs,
  },
  rowHeader: {
    gap: 2,
  },
  // Rails run edge to edge: cancel the PDP's 16pt gutter, then pad it back
  // inside the scroll content so the first tile still lines up with the text.
  rail: {
    marginHorizontal: -spacing.sm,
  },
  railContent: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
});

export default CardSimilarSection;

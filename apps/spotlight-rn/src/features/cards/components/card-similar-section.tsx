import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AppText, CardRailTile, spacing } from '@spotlight/design-system';
import type { SimilarCard, SimilarCards, SpotlightRepository } from '@spotlight/api-client';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';
import { AnalyticsEvent } from '@/lib/observability/analytics-events';
import { capturePostHogEvent } from '@/lib/observability/posthog';

type SimilarRow = 'goes_with' | 'same_name' | 'cheaper';

/** Non-empty rows in a payload — the section renders exactly these. */
export function similarRowCount(similar: SimilarCards): number {
  return (similar.goesWith ? 1 : 0)
    + (similar.sameName.length > 0 ? 1 : 0)
    + (similar.sameLookCheaper.length > 0 ? 1 : 0);
}

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
 * "Similar cards" (docs/meta-feed-mockup/v2/SimilarV7): up to three rows from
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

  // Once per card page, and only when the section actually has content.
  const reportedShownForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!similar || similar.cardId !== cardId || reportedShownForRef.current === cardId) {
      return;
    }
    const rows = similarRowCount(similar);
    if (rows === 0) {
      return;
    }
    reportedShownForRef.current = cardId;
    capturePostHogEvent(AnalyticsEvent.similarCardsShown, {
      rows,
      has_goes_with: similar.goesWith != null,
    });
  }, [cardId, similar]);

  if (!similar || similar.cardId !== cardId) {
    return null;
  }
  const { goesWith, sameName, sameLookCheaper } = similar;
  if (!goesWith && sameName.length === 0 && sameLookCheaper.length === 0) {
    return null;
  }
  const openCard = (card: SimilarCard, row: SimilarRow, rank: number) => {
    capturePostHogEvent(AnalyticsEvent.similarCardOpened, { row, rank });
    onPressCard(card);
  };
  // A null title renders the rail bare, directly under the section title.
  const renderRail = (
    key: string,
    row: SimilarRow,
    title: string | null,
    caption: string | null,
    cards: SimilarCard[],
  ) =>
    cards.length === 0 ? null : (
      <View style={styles.row} testID={testID ? `${testID}-${key}` : undefined}>
        {title ? (
          <View style={styles.rowHeader}>
            <AppText color="gray900" variant="titleSmall">{title}</AppText>
            {caption ? <AppText color="gray600" variant="captionMedium">{caption}</AppText> : null}
          </View>
        ) : null}
        <ScrollView
          contentContainerStyle={styles.railContent}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.rail}
        >
          {cards.map((card, index) => (
            <CardRailTile
              imageUrl={card.imageUrl}
              key={card.cardId}
              name={card.name}
              onPress={() => openCard(card, row, index + 1)}
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
      <AppText color="gray900" variant="titleMedium">Similar cards</AppText>

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
            onPress={() => openCard(goesWith, 'goes_with', 1)}
            priceLabel={priceLabel(goesWith)}
            subtitle={[goesWith.setName, goesWith.number].filter(Boolean).join(' · ')}
            testID={testID ? `${testID}-goes-with-${goesWith.cardId}` : undefined}
          />
        </View>
      ) : null}

      {renderRail('same-name', 'same_name', null, null, sameName)}
      {renderRail('cheaper', 'cheaper', 'Same look, lower price', null, sameLookCheaper)}
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

import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';

import type {
  CardPricePosition,
  CardPricePositionQuery,
  CardPriceTrendMode,
  CardPriceTrendRow,
  SpotlightRepository,
} from '@spotlight/api-client';
import { PricePositionBar, spacing } from '@spotlight/design-system';

import { formatCurrency } from '@/features/portfolio/components/portfolio-formatting';

/**
 * The charted row as a price-position query. Raw rows are keyed by condition
 * code; graded rows by "<grader> <grade>" (CardPriceTrendRow.key).
 */
export function pricePositionQueryForRow(
  cardId: string,
  variant: string | null,
  mode: CardPriceTrendMode,
  row: CardPriceTrendRow,
): CardPricePositionQuery {
  if (mode === 'graded') {
    const [grader, ...rest] = row.key.trim().split(/\s+/);
    return { cardId, variant, grader: grader || null, grade: rest.join(' ') || null, condition: null };
  }
  return { cardId, variant, condition: row.key, grader: null, grade: null };
}

type CardPricePositionBarProps = {
  repository: SpotlightRepository;
  cardId: string;
  variant: string | null;
  mode: CardPriceTrendMode;
  row: CardPriceTrendRow;
  testID?: string;
};

/**
 * "Cheap or pricey" under the PDP price, for exactly the printing + condition
 * or grade being charted. Renders nothing until (and unless) there is data.
 */
export function CardPricePositionBar({
  repository,
  cardId,
  variant,
  mode,
  row,
  testID = 'detail-price-position',
}: CardPricePositionBarProps) {
  const query = pricePositionQueryForRow(cardId, variant, mode, row);
  const key = [query.cardId, query.variant, query.condition, query.grader, query.grade].join('|');
  const [result, setResult] = useState<{ key: string; position: CardPricePosition | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    repository.getCardPricePosition(query)
      .then((position) => {
        if (!cancelled) {
          setResult({ key, position });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({ key, position: null });
        }
      });
    return () => {
      cancelled = true;
    };
    // `key` captures every field of `query`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, repository]);

  const position = result?.key === key ? result.position : null;
  if (!position || !(position.highUsd > position.lowUsd)) {
    return null;
  }
  return (
    <PricePositionBar
      detail={position.windowLabel ? position.windowLabel[0].toUpperCase() + position.windowLabel.slice(1) : undefined}
      highLabel={formatCurrency(position.highUsd)}
      lowLabel={formatCurrency(position.lowUsd)}
      percentile={position.percentile}
      style={styles.bar}
      testID={testID}
    />
  );
}

const styles = StyleSheet.create({
  bar: {
    alignSelf: 'stretch',
    paddingVertical: spacing.xxs,
  },
});

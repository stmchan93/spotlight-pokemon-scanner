import { CardListRow } from '@spotlight/design-system';
import type { InventoryCardEntry } from '@spotlight/api-client';

import { getCardImageUrl } from '@/lib/card-images';

function gradeLabelFor(entry: InventoryCardEntry): string | null {
  if (entry.kind === 'graded' && entry.slabContext) {
    const grader = (entry.slabContext.grader ?? '').trim();
    const grade = (entry.slabContext.grade ?? '').trim();
    const combined = [grader, grade].filter(Boolean).join(' ');
    return combined.length > 0 ? combined : null;
  }
  const short = (entry.conditionShortLabel ?? '').trim();
  return short.length > 0 ? short : null;
}

type CollectionListRowProps = {
  entry: InventoryCardEntry;
  firstInSection: boolean;
  onPress: (entry: InventoryCardEntry) => void;
};

/**
 * One full-bleed ruled list row, extracted so the collection screen can render
 * it as a virtualized FlatList item while keeping identical markup/testIDs.
 */
export function CollectionListRow({ entry, firstInSection, onPress }: CollectionListRowProps) {
  return (
    <CardListRow
      cardNumber={entry.cardNumber}
      currencyCode={entry.currencyCode ?? 'USD'}
      firstInSection={firstInSection}
      gradeLabel={gradeLabelFor(entry)}
      imageUrl={getCardImageUrl(entry, 'small')}
      marketPrice={entry.hasMarketPrice ? entry.marketPrice : null}
      name={entry.name}
      onPress={() => onPress(entry)}
      quantity={entry.quantity}
      setName={entry.setName}
      testID={`card-list-row-${entry.cardId}`}
      trendChangeAmount={entry.dayChangeAmount ?? null}
    />
  );
}

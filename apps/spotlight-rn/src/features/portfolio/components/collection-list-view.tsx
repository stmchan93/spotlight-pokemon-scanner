import { StyleSheet, View } from 'react-native';

import { CardListRow } from '@spotlight/design-system';
import type { InventoryCardEntry } from '@spotlight/api-client';

import { getCardImageUrl } from '@/lib/card-images';

type CollectionListViewProps = {
  entries: InventoryCardEntry[];
  onPressEntry: (entry: InventoryCardEntry) => void;
  testID?: string;
};

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

export function CollectionListView({
  entries,
  onPressEntry,
  testID = 'collection-list-view',
}: CollectionListViewProps) {
  return (
    <View style={styles.list} testID={testID}>
      {entries.map((entry, index) => (
        <CardListRow
          key={entry.id}
          firstInSection={index === 0}
          imageUrl={getCardImageUrl(entry, 'small')}
          name={entry.name}
          cardNumber={entry.cardNumber}
          setName={entry.setName}
          gradeLabel={gradeLabelFor(entry)}
          marketPrice={entry.hasMarketPrice ? entry.marketPrice : null}
          currencyCode={entry.currencyCode ?? 'USD'}
          trendChangeAmount={entry.dayChangeAmount ?? null}
          quantity={entry.quantity}
          onPress={() => onPressEntry(entry)}
          testID={`card-list-row-${entry.cardId}`}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    // Rows stack flush (no inter-row gap) and full-bleed (no horizontal
    // gutter) so the per-row top/bottom hairlines run edge to edge and form
    // one continuous ruled list, matching the full-width Figma "Price
    // Container" row (669:8573). Each row keeps its own 16px content padding.
    paddingVertical: 16,
  },
});

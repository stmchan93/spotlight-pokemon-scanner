import { CardListRow } from '@spotlight/design-system';
import type { InventoryCardEntry } from '@spotlight/api-client';

import { getCardImageUrl } from '@/lib/card-images';

// "Variant · Condition" for raw ("Holofoil · NM") and "Variant · Grader Grade"
// for slabs — the variant leads, then the dot, then the quality (user ask; the
// bare abbreviated condition read as cryptic).
function gradeLabelFor(entry: InventoryCardEntry): string | null {
  if (entry.kind === 'graded' && entry.slabContext) {
    const grader = (entry.slabContext.grader ?? '').trim();
    const grade = (entry.slabContext.grade ?? '').trim();
    const gradeText = [grader, grade].filter(Boolean).join(' ');
    const variant = (entry.slabContext.variantName ?? '').trim();
    const combined = [variant, gradeText].filter(Boolean).join(' · ');
    return combined.length > 0 ? combined : null;
  }
  const variant = (entry.variantName ?? '').trim();
  // Full condition ("Near Mint"), not the NM abbreviation (user ask).
  const condition = (entry.conditionLabel ?? entry.conditionShortLabel ?? '').trim();
  const combined = [variant, condition].filter(Boolean).join(' · ');
  return combined.length > 0 ? combined : null;
}

type CollectionListRowProps = {
  entry: InventoryCardEntry;
  firstInSection: boolean;
  onPress: (entry: InventoryCardEntry) => void;
  /** Long-press opens the card actions menu. */
  onLongPress?: (entry: InventoryCardEntry) => void;
  /** Long-press delay in ms (press-and-hold to open the menu). */
  delayLongPress?: number;
  /** Renders the leading selection check-circle while edit mode is active. */
  selectable?: boolean;
  /** Whether this row is currently selected (edit mode). */
  selected?: boolean;
};

/**
 * One full-bleed ruled list row, extracted so the collection screen can render
 * it as a virtualized FlatList item while keeping identical markup/testIDs.
 */
export function CollectionListRow({
  entry,
  firstInSection,
  onPress,
  onLongPress,
  delayLongPress,
  selectable = false,
  selected = false,
}: CollectionListRowProps) {
  return (
    <CardListRow
      cardNumber={entry.cardNumber}
      currencyCode={entry.currencyCode ?? 'USD'}
      delayLongPress={delayLongPress}
      firstInSection={firstInSection}
      gradeLabel={gradeLabelFor(entry)}
      // Slab-case frame on the thumbnail (Figma 2609:6812) — keyed by THIS
      // entry's grader; the text line above stays plain "PSA 10".
      grader={entry.kind === 'graded' ? entry.slabContext?.grader ?? null : null}
      grade={entry.kind === 'graded' ? entry.slabContext?.grade ?? null : null}
      imageUrl={getCardImageUrl(entry, 'small')}
      marketPrice={entry.hasMarketPrice ? entry.marketPrice : null}
      name={entry.name}
      onLongPress={onLongPress ? () => onLongPress(entry) : undefined}
      onPress={() => onPress(entry)}
      quantity={entry.quantity}
      selectable={selectable}
      selected={selected}
      setName={entry.setName}
      testID={`card-list-row-${entry.cardId}`}
      trendChangeAmount={entry.dayChangeAmount ?? null}
    />
  );
}

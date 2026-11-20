import {
  setRarityChipsForGame,
  type CardGame,
  type CatalogSearchResult,
  type InventoryCardEntry,
  type RarityBucket,
  type SetProgress,
} from '@spotlight/api-client';

export type SetCompletion = {
  owned: number;
  total: number;
  /** 0..1, for the ProgressBar. */
  fraction: number;
  /** Whole percent for the label. Never reads 100 until every card is owned. */
  percent: number;
};

/**
 * "X of Y" for one set. Null when the total is unknown (an older backend sent
 * no `cardCount`) — the UI hides completion rather than guessing a denominator.
 * A set with no cards is 0%, not NaN.
 */
export function setCompletion(cardCount: number | null | undefined, ownedCount: number | null | undefined): SetCompletion | null {
  if (cardCount == null || !Number.isFinite(cardCount)) {
    return null;
  }
  const total = Math.max(0, Math.floor(cardCount));
  const owned = Math.min(total, Math.max(0, Math.floor(ownedCount ?? 0)));
  if (total === 0) {
    return { owned: 0, total: 0, fraction: 0, percent: 0 };
  }
  const fraction = owned / total;
  const rounded = Math.round(fraction * 100);
  // 199 of 200 rounds to 100%; the label must not claim a finished set.
  const percent = owned < total ? Math.min(99, rounded) : 100;
  return { owned, total, fraction, percent };
}

export function completionCountLabel(completion: SetCompletion): string {
  return `${completion.owned} of ${completion.total} CARDS`;
}

/** Owned-card counts by set id; a set missing from the response owns 0. */
export function ownedCountsByExpansion(progress: SetProgress | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of progress?.sets ?? []) {
    counts[entry.expansionId] = entry.ownedCount;
  }
  return counts;
}

/**
 * Release date as M/D/YYYY (Figma "5/22/2026"). Parsed from the string, not
 * through `Date`, so a UTC midnight never slips to the previous day.
 */
export function formatSetReleaseDate(releaseDate: string | null | undefined): string | null {
  const match = releaseDate?.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) {
    return releaseDate?.trim() || null;
  }
  const [, year, month, day] = match;
  return `${Number(month)}/${Number(day)}/${year}`;
}

/** Distinct cards in the list the user owns at least one copy of. */
export function countOwnedCards(cards: readonly CatalogSearchResult[]): number {
  return cards.reduce((count, card) => count + ((card.ownedQuantity ?? 0) > 0 ? 1 : 0), 0);
}

/** The set page's rarity chips: only buckets this set's cards actually have, in chip order, labeled for the game. */
export function rarityChipsForCards(
  cards: readonly CatalogSearchResult[],
  game?: CardGame | null,
): { bucket: RarityBucket; label: string }[] {
  const present = new Set(cards.map((card) => card.rarityBucket).filter(Boolean));
  return setRarityChipsForGame(game).filter((chip) => present.has(chip.bucket));
}

/** Client-side search + rarity filter over the whole set (it is loaded in one call). */
export function filterSetCards(
  cards: readonly CatalogSearchResult[],
  query: string,
  bucket: RarityBucket | null,
): CatalogSearchResult[] {
  const needle = query.trim().toLowerCase();
  const digits = needle.replace(/^#/, '');
  return cards.filter((card) => {
    if (bucket && card.rarityBucket !== bucket) {
      return false;
    }
    if (!needle) {
      return true;
    }
    if (card.name.toLowerCase().includes(needle)) {
      return true;
    }
    // "#025/120": a typed "25" or "025" matches the collector number from its
    // start (so it doesn't also match #125); a typed "25/120" matches whole.
    const number = card.cardNumber.toLowerCase().replace(/^#/, '');
    if (digits.includes('/')) {
      return number.replace(/^0+/, '').startsWith(digits.replace(/^0+/, ''));
    }
    const collector = number.split('/')[0].replace(/^0+/, '');
    const typed = digits.replace(/^0+/, '');
    return typed.length > 0 && collector.startsWith(typed);
  });
}

/** "#001/120": the set page's number line (the API's `cardNumber` may or may not carry the "#"). */
export function setCardNumberLabel(cardNumber: string): string {
  const trimmed = cardNumber.trim();
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

/** One owned copy as the "which copy?" sheet lists it: printing · condition (or grader grade). */
export function ownedCopyLabel(entry: InventoryCardEntry): string {
  const parts: string[] = [];
  if (entry.kind === 'graded') {
    const grade = [entry.slabContext?.grader, entry.slabContext?.grade].filter(Boolean).join(' ');
    parts.push(grade || 'Graded');
    const printing = entry.slabContext?.variantName && entry.slabContext.variantName !== grade
      ? entry.slabContext.variantName
      : null;
    if (printing) {
      parts.push(printing);
    }
  } else {
    if (entry.variantName) {
      parts.push(entry.variantName);
    }
    parts.push(entry.conditionLabel ?? entry.conditionShortLabel ?? 'Near Mint');
  }
  return parts.join(' · ');
}

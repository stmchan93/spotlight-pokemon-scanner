import type { ExpansionRecord } from '@spotlight/api-client';

/**
 * "44K", "1.2K", "182": the Search landing's "(N RESULTS)" counts (Figma
 * 6597:5654). One decimal under 10K, whole thousands above; millions likewise.
 */
export function formatCompactCount(value: number): string {
  const count = Math.max(0, Math.floor(value));
  const compact = (scaled: number, suffix: string) => {
    const rounded = scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
    return `${rounded}${suffix}`;
  };
  if (count >= 999_500) {
    return compact(count / 1_000_000, 'M');
  }
  if (count >= 1000) {
    return compact(count / 1000, 'K');
  }
  return String(count);
}

/** "(44K RESULTS)" — null when the count is unknown, so the header shows the title alone. */
export function resultsCountLabel(count: number | null | undefined): string | null {
  return count == null ? null : `(${formatCompactCount(count)} RESULTS)`;
}

/**
 * Every card in the game: the sum of its sets' `cardCount`. Null when no set
 * carries one (an older backend), rather than claiming "0 RESULTS".
 */
export function totalCardCount(expansions: readonly ExpansionRecord[]): number | null {
  let total = 0;
  let known = false;
  for (const expansion of expansions) {
    if (typeof expansion.cardCount === 'number' && Number.isFinite(expansion.cardCount)) {
      total += Math.max(0, expansion.cardCount);
      known = true;
    }
  }
  return known ? total : null;
}

/**
 * The sets the SINGLES rail reads its cards from, best first: main sets (no
 * promos) that have cards, English ahead of other languages, keeping the list
 * order (newest first). The rail walks these until one returns cards — a set
 * released today can be listed before its cards are synced.
 */
export function singlesSourceSets(
  orderedSets: readonly ExpansionRecord[],
  limit = 3,
): ExpansionRecord[] {
  const candidates = orderedSets.filter((set) => !set.isPromo && (set.cardCount ?? 1) > 0);
  const isEnglish = (set: ExpansionRecord) => !set.language || set.language === 'English';
  return [...candidates.filter(isEnglish), ...candidates.filter((set) => !isEnglish(set))].slice(0, limit);
}

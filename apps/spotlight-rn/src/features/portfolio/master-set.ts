import type { CardGame, ExpansionRecord, SetProgress } from '@spotlight/api-client';

import { setCompletion, type SetCompletion } from '@/features/catalog/set-progress';

/** One set on Home → MASTER SET: a set you own at least one card of. */
export type MasterSetRow = {
  key: string;
  game: CardGame;
  expansion: ExpansionRecord;
  ownedCount: number;
  /** Null when the set's size is unknown (older backend): sorts last. */
  completion: SetCompletion | null;
};

export type MasterSetGameInput = {
  game: CardGame;
  progress: SetProgress;
  expansions: readonly ExpansionRecord[];
};

/**
 * THE SORT: closest to finished first.
 *
 *   1. completion (exact fraction, not the rounded label) — descending;
 *   2. tie → more cards owned first, so 50/100 beats 1/2 at the same 50%;
 *   3. tie → set name, so the order is stable between reads.
 *
 * Why completion and not raw owned count: this tab is about MASTER sets — the
 * question it answers is "which sets am I closest to finishing", and the bar
 * every row draws is that same percent, so the list reads as a ranking you can
 * see. Owned count still decides between equal percents. Sets of unknown size
 * have no percent and fall to the end, by owned count.
 */
export function compareMasterSetRows(a: MasterSetRow, b: MasterSetRow): number {
  const fa = a.completion?.fraction ?? -1;
  const fb = b.completion?.fraction ?? -1;
  if (fa !== fb) {
    return fb - fa;
  }
  if (a.ownedCount !== b.ownedCount) {
    return b.ownedCount - a.ownedCount;
  }
  return a.expansion.name.localeCompare(b.expansion.name, undefined, { sensitivity: 'base' });
}

/**
 * Joins each game's owned-per-set counts to its set records. A progress entry
 * for a set the catalog does not list is dropped: there is no name to show.
 */
export function buildMasterSetRows(inputs: readonly MasterSetGameInput[]): MasterSetRow[] {
  const rows: MasterSetRow[] = [];
  for (const { game, progress, expansions } of inputs) {
    const byId = new Map(expansions.map((expansion) => [expansion.id, expansion] as const));
    for (const entry of progress.sets) {
      const expansion = byId.get(entry.expansionId);
      if (!expansion || entry.ownedCount <= 0) {
        continue;
      }
      rows.push({
        key: `${game}:${expansion.id}`,
        game,
        expansion,
        ownedCount: entry.ownedCount,
        completion: setCompletion(expansion.cardCount, entry.ownedCount),
      });
    }
  }
  return rows.sort(compareMasterSetRows);
}

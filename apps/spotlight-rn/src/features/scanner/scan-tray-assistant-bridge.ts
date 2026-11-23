import {
  deckConditionOptions,
  type AssistantCardRef,
  type AssistantConditionCode,
  type AssistantTrayAddRow,
  type AssistantTrayRow,
  type CatalogSearchResult,
} from '@spotlight/api-client';

import type { ScanPriceSheetSelection } from './screens/scan-price-sheet';
import { activeCandidateForCapture } from './screens/scanner-screen-helpers';
import type { RecentCapture } from './screens/scanner-screen-types';
import { scanRowInventoryTarget } from './scan-row-grading';

/*
  The Ask Ekalight chat → the scan tray. The tray is the scanner screen's own
  store; the chat is a pushed route. While mounted, the scanner registers this
  bridge (mount, not focus: the chat covers it while it's open), and the chat
  reads the rows to send as context and applies a confirmed tray action through
  the SAME functions the tray's own controls run (row change-match, ADD path,
  swipe-delete), so persistence, candidates[] and pricing behave identically.
*/

/** `note`: a partial result worth saying (some rows had already left the tray). */
export type ScanTrayActionOutcome = { status: 'done'; note?: string } | { status: 'failed'; message: string };

export type ScanTraySwapInput = {
  rowRef: string;
  fromCardId: string;
  toCardId: string;
  toCard: AssistantCardRef | null;
};

export type ScanTrayAssistantBridge = {
  /** The live tray rows, newest first (what the tray shows). */
  rows: () => AssistantTrayRow[];
  /** Files these rows with the scanner's add path; rows that changed or left are skipped. */
  addRows: (rows: readonly AssistantTrayAddRow[]) => Promise<ScanTrayActionOutcome>;
  swapCard: (input: ScanTraySwapInput) => ScanTrayActionOutcome;
  removeRow: (input: { rowRef: string; cardId: string }) => ScanTrayActionOutcome;
};

/** `page.params.view` of a chat opened from the tray header: picks the tray starter chips. */
export const ASSISTANT_TRAY_VIEW = 'scan_tray';

export const TRAY_ROW_GONE_MESSAGE = "That card isn't in your scan tray anymore.";
export const TRAY_GONE_MESSAGE = "Those cards aren't in your scan tray anymore.";

let activeBridge: ScanTrayAssistantBridge | null = null;

/** Called by the mounted scanner; returns the unregister. Latest registration wins. */
export function registerScanTrayAssistantBridge(bridge: ScanTrayAssistantBridge): () => void {
  activeBridge = bridge;
  return () => {
    if (activeBridge === bridge) {
      activeBridge = null;
    }
  };
}

export function getScanTrayAssistantBridge(): ScanTrayAssistantBridge | null {
  return activeBridge;
}

function assistantCondition(code: string | null | undefined): AssistantConditionCode | null {
  const short = deckConditionOptions.find((option) => option.code === code)?.shortLabel;
  return short === 'NM' || short === 'LP' || short === 'MP' || short === 'HP' || short === 'DMG' ? short : null;
}

/**
 * Tray rows as the chat sees them: each settled row's matched card, filed the
 * way ADD / ADD ALL would file it (`scanRowInventoryTarget` + the row's
 * printing). Loading or unmatched rows are left out; ≤20 (contract cap).
 */
export function assistantTrayRows(
  captures: readonly RecentCapture[],
  selections: ReadonlyMap<string, ScanPriceSheetSelection>,
  printingLabel: (capture: RecentCapture, candidate: CatalogSearchResult) => string | null,
): AssistantTrayRow[] {
  const rows: AssistantTrayRow[] = [];
  for (const capture of captures) {
    if (capture.isLoadingCandidates || capture.recentlyAdded) {
      continue;
    }
    const candidate = activeCandidateForCapture(capture);
    if (!candidate) {
      continue;
    }
    const target = scanRowInventoryTarget(capture, selections.get(capture.id));
    const graded = target.mode === 'slabs' && !!target.slabContext?.grader;
    rows.push({
      rowRef: capture.id,
      cardId: candidate.cardId,
      condition: graded ? null : assistantCondition(target.conditionCode) ?? 'NM',
      grader: graded ? target.slabContext?.grader ?? null : null,
      grade: graded ? target.slabContext?.grade ?? null : null,
      quantity: 1,
      variant: graded ? null : printingLabel(capture, candidate),
    });
    if (rows.length >= 20) {
      break;
    }
  }
  return rows;
}

/** The live row an action names, only while it still shows `cardId`. */
export function findTrayRow(
  captures: readonly RecentCapture[],
  rowRef: string,
  cardId: string,
): RecentCapture | null {
  const capture = captures.find((entry) => entry.id === rowRef);
  if (!capture || capture.isLoadingCandidates || capture.recentlyAdded || capture.isAddingToInventory) {
    return null;
  }
  return activeCandidateForCapture(capture)?.cardId === cardId ? capture : null;
}

/**
 * The swap target as a tray candidate, for a card the matcher didn't return:
 * appended after the existing candidates (never replacing any).
 */
export function catalogResultFromAssistantCard(cardId: string, card: AssistantCardRef | null): CatalogSearchResult {
  return {
    id: cardId,
    cardId,
    name: card?.name ?? '',
    cardNumber: card?.number ?? '',
    setName: card?.setName ?? '',
    imageUrl: card?.imageSmallUrl ?? '',
    smallImageUrl: card?.imageSmallUrl ?? null,
    marketPrice: card?.priceUsd ?? null,
    currencyCode: card?.priceUsd != null ? 'USD' : null,
  };
}

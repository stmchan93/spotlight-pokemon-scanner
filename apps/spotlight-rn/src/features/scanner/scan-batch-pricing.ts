import type {
  CatalogSearchResult,
  DeckConditionCode,
  RawPricingMatrix,
  RawPricingMatrixVariant,
} from '@spotlight/api-client';

import {
  buildScanPriceSelection,
  conditionCodeToDeckCondition,
  type ScanPriceSheetSelection,
} from './screens/scan-price-sheet';
import { activeCandidateForCapture } from './screens/scanner-screen-helpers';
import type { RecentCapture } from './screens/scanner-screen-types';

/**
 * Printing chip copy for a tray row / binder pocket (printing only).
 *
 * With no user choice the chip still names WHAT the shown price assumes —
 * "Default" — so a guessed printing reads as a guess instead of a fact.
 * (The #1 complaint across competitor scanners is a card silently landing on
 * 1st Edition / holo / non-holo and the user never seeing it.)
 */
export const defaultPrintingConditionCode = 'NM';

/**
 * The catalog payload does not yet carry the default printing's name
 * (`pricing.variant` is dropped by the api-client scan-candidate mapper). Read
 * it forward-compatibly: the moment the client exposes `defaultVariantLabel`
 * the chip names the real printing with no further change here.
 */
type CandidateWithDefaultPrinting = CatalogSearchResult & {
  defaultVariantLabel?: string | null;
};

export function defaultPrintingLabel(candidate: CatalogSearchResult | null): string {
  const label = (candidate as CandidateWithDefaultPrinting | null)?.defaultVariantLabel;
  return typeof label === 'string' && label.trim().length > 0 ? label.trim() : 'Default';
}

export function printingChipLabel(
  candidate: CatalogSearchResult | null,
  selection: ScanPriceSheetSelection | null | undefined,
): string {
  // Printing ONLY (user 2026-09-09: "it's just supposed to be the variants
  // there, not LP and stuff"). Condition lives in the price sheet the chip opens.
  if (selection) {
    return selection.variantLabel;
  }
  return defaultPrintingLabel(candidate);
}

/**
 * The printings "Set all" offers when the page's candidates carry no variant
 * list of their own. Applied per pocket only where that printing exists in the
 * card's pricing matrix — a Base Set holo has no "Reverse Holofoil" row and is
 * skipped (and counted) rather than forced.
 */
export const standardPrintingOptions = [
  'Normal',
  'Holofoil',
  'Reverse Holofoil',
  'Unlimited',
  '1st Edition',
] as const;

function normalizePrintingLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Case/whitespace-insensitive printing lookup in a card's matrix. */
export function findMatrixVariant(
  matrix: RawPricingMatrix | null | undefined,
  printingLabel: string,
): RawPricingMatrixVariant | null {
  if (!matrix) {
    return null;
  }
  const wanted = normalizePrintingLabel(printingLabel);
  return matrix.variants.find((variant) => normalizePrintingLabel(variant.variant) === wanted) ?? null;
}

function deckConditionToCode(condition: DeckConditionCode | null | undefined): string | null {
  if (!condition) {
    return null;
  }
  const match = Object.entries(conditionCodeToDeckCondition).find(([, deck]) => deck === condition);
  return match?.[0] ?? null;
}

/**
 * A pocket's selection after "Set all → <printing>": the requested printing
 * with the pocket's already-chosen condition kept where that printing prices
 * it, else NM, else the printing's first condition. Null when the card has no
 * such printing — the caller counts it as skipped.
 */
export function selectionForPrinting(
  matrix: RawPricingMatrix | null | undefined,
  printingLabel: string,
  current: ScanPriceSheetSelection | null | undefined,
): ScanPriceSheetSelection | null {
  const variant = findMatrixVariant(matrix, printingLabel);
  if (!variant) {
    return null;
  }
  const currentCode = deckConditionToCode(current?.conditionCode);
  const condition = (currentCode ? variant.conditions.find((entry) => entry.code === currentCode) : undefined)
    ?? variant.conditions.find((entry) => entry.code === defaultPrintingConditionCode)
    ?? variant.conditions[0];
  if (!condition) {
    return null;
  }
  return {
    ...buildScanPriceSelection(variant, condition.code, condition.market ?? null),
    variantIsNonDefault: isNonDefaultVariant(matrix, variant.variantKey),
  };
}

/**
 * The card's OWN printing is the matrix's first variant — the one the scanned
 * price already reflects. Anything else is a printing the user chose, and only
 * those earn a line on the binder tile (user, 2026-09-10).
 */
function isNonDefaultVariant(
  matrix: RawPricingMatrix | null | undefined,
  variantKey: string,
): boolean {
  const defaultKey = matrix?.variants[0]?.variantKey;
  return !!defaultKey && defaultKey !== variantKey;
}

/**
 * Word-level shorthands for a printing name. The binder tile names a printing
 * on the SAME line as the price, which leaves it roughly half a ~100pt tile —
 * so the label is abbreviated rather than left to ellipsize into something the
 * user can't read ("Reverse Holof…", user 2026-09-10).
 */
const printingWordShorthands: Record<string, string> = {
  '1st': '1st',
  cracked: 'Crk',
  edition: 'Ed',
  first: '1st',
  foil: 'Foil',
  holo: 'Holo',
  holofoil: 'Holo',
  ice: 'Ice',
  rainbow: 'Rnbw',
  reverse: 'Rev',
  shadowless: 'Shdwls',
  unlimited: 'Unltd',
};

/** How wide the abbreviation is allowed to get before words are dropped. */
const printingAbbreviationMaxLength = 9;

/**
 * "Reverse Holofoil" → "Rev Holo", "1st Edition" → "1st Ed",
 * "Cracked Ice Holofoil" → "Crk Ice".
 *
 * Words are shortened, then kept only while the result still fits — dropping a
 * trailing word beats truncating mid-word, because the words that survive stay
 * readable. A single word longer than the budget is cut with an explicit
 * period so it reads as an abbreviation rather than as clipped text.
 */
export function printingAbbreviation(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return '';
  }
  const short = words.map((word) => {
    const key = word.toLowerCase().replace(/[^a-z0-9]/g, '');
    return printingWordShorthands[key] ?? word;
  });

  let result = short[0];
  if (result.length > printingAbbreviationMaxLength) {
    return `${result.slice(0, printingAbbreviationMaxLength - 1)}.`;
  }
  for (const word of short.slice(1)) {
    const next = `${result} ${word}`;
    if (next.length > printingAbbreviationMaxLength) {
      break;
    }
    result = next;
  }
  return result;
}

/**
 * Per-card pricing-matrix cache shared by a batch apply: nine pockets of the
 * same page fetch at most nine matrices, and re-applying never refetches. A
 * failed fetch caches an EMPTY matrix so a dead card isn't retried on every
 * chip tap.
 */
export type RawPricingMatrixCache = Map<string, Promise<RawPricingMatrix>>;

export function fetchRawPricingMatrixCached(
  cache: RawPricingMatrixCache,
  fetchMatrix: (cardId: string) => Promise<RawPricingMatrix>,
  cardId: string,
): Promise<RawPricingMatrix> {
  const cached = cache.get(cardId);
  if (cached) {
    return cached;
  }
  const request = fetchMatrix(cardId).catch((): RawPricingMatrix => ({
    cardID: cardId,
    currencyCode: 'USD',
    variants: [],
  }));
  cache.set(cardId, request);
  return request;
}

/**
 * Printing only. Condition was a second dropdown here until 2026-09-10: it
 * doubled the toolbar and the per-pocket confirmation it needed, for a value
 * every scan already starts on. It lives on the card's own price sheet.
 */
export type BatchPriceSelectionRequest = { kind: 'printing'; printingLabel: string };

export type BatchPriceSelectionResult = {
  /** Selections to merge into the tray's price-selection map. */
  entries: { captureId: string; selection: ScanPriceSheetSelection }[];
  /** Pockets that had a candidate but no matching printing / matrix. */
  skipped: number;
  /** Pockets considered (matched, not loading, not empty). */
  eligible: number;
};

/**
 * Resolve "Set all" for one binder page. Matrices are fetched in parallel
 * (bounded by the page: ≤ 18 pockets) through the shared cache.
 */
export async function resolveBatchPriceSelections(
  pockets: readonly RecentCapture[],
  request: BatchPriceSelectionRequest,
  currentSelections: ReadonlyMap<string, ScanPriceSheetSelection>,
  cache: RawPricingMatrixCache,
  fetchMatrix: (cardId: string) => Promise<RawPricingMatrix>,
): Promise<BatchPriceSelectionResult> {
  const targets = pockets.flatMap((capture) => {
    if (capture.isLoadingCandidates || capture.binderPage?.empty || capture.mode !== 'raw') {
      return [];
    }
    const candidate = activeCandidateForCapture(capture);
    return candidate?.cardId ? [{ capture, candidate }] : [];
  });

  const matrices = await Promise.all(
    targets.map(({ candidate }) => fetchRawPricingMatrixCached(cache, fetchMatrix, candidate.cardId)),
  );

  const entries: BatchPriceSelectionResult['entries'] = [];
  let skipped = 0;
  targets.forEach(({ capture }, index) => {
    const current = currentSelections.get(capture.id) ?? null;
    const selection = selectionForPrinting(matrices[index], request.printingLabel, current);
    if (selection) {
      entries.push({ captureId: capture.id, selection });
    } else {
      skipped += 1;
    }
  });

  return { entries, skipped, eligible: targets.length };
}

/** "Applied to 7 of 9 · 2 have no Holofoil printing" */
export function describeBatchPriceResult(
  request: BatchPriceSelectionRequest,
  result: BatchPriceSelectionResult,
): string {
  const applied = result.entries.length;
  const head = `Applied to ${applied} of ${result.eligible}`;
  if (result.skipped === 0) {
    return head;
  }
  const has = result.skipped === 1 ? 'has' : 'have';
  return `${head} · ${result.skipped} ${has} no ${request.printingLabel} variant`;
}

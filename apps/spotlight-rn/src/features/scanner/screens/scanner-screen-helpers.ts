import { Platform, Vibration } from 'react-native';

// Static import (matches the working portfolio-chart scrub haptic). The previous
// lazy `await import('expo-haptics')` added first-call latency and obscured
// failures. NOTE: expo-haptics is a NATIVE module — if it isn't compiled into
// the installed binary, `impactAsync`/`notificationAsync` throw at runtime and
// no JS change or OTA can fix it; only a fresh native build links it.
import * as Haptics from 'expo-haptics';

import {
  DEFAULT_CARD_GAME,
  gameDisplayName,
  isSpotlightRepositoryRequestError,
  type CardGame,
  type CatalogSearchResult,
  type InventoryCardEntry,
  type ScannerSlabAnalysisPayload,
  type SlabContext,
} from '@spotlight/api-client';

import { analyzePSASlabCapture } from '@/features/scanner/slab-native-analysis';

import type { RecentCapture, ScannerMode } from './scanner-screen-types';

export const unsupportedSlabTitle = 'Slab type is currently not supported';
export const unsupportedSlabSubtitle = 'We currently only support PSA slabs for now.';

export function scannerErrorMessage(error: unknown) {
  if (isSpotlightRepositoryRequestError(error)) {
    return `${error.kind}:${error.status ?? 'n/a'}:${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown scanner error';
}

export function scannerErrorKind(error: unknown) {
  if (isSpotlightRepositoryRequestError(error)) {
    return error.kind;
  }

  if (
    error != null
    && typeof error === 'object'
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }

  if (error instanceof Error) {
    const trimmedMessage = error.message.trim();
    if (/^[a-z0-9_:-]+$/i.test(trimmedMessage) && trimmedMessage.length > 0) {
      return trimmedMessage;
    }

    return error.name || error.constructor.name || 'Error';
  }

  return 'UnknownError';
}

export function logScannerDiagnostic(message: string, error?: unknown) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  // Keep scanner failures out of React Native LogBox. These are expected runtime
  // failures when the network/auth/backend flakes and should not appear as UI.
  const suffix = error ? ` native=${scannerErrorMessage(error)}` : '';
  console.info(`${message}${suffix}`);
}

export function alignToFourPointGrid(value: number) {
  return Math.max(0, Math.round(value / 4) * 4);
}

export function capturePrimaryLabel(mode: ScannerMode) {
  return mode === 'slabs' ? 'SLAB scan' : 'RAW scan';
}

export function isNonPSAUnsupportedSlabCapture(capture: RecentCapture) {
  if (capture.mode !== 'slabs' || capture.matchReviewDisposition !== 'unsupported') {
    return false;
  }

  const reviewReason = capture.matchReviewReason?.trim();
  return reviewReason === 'PSA only for now.' || reviewReason === unsupportedSlabSubtitle;
}

export function captureFailureTitle(capture: RecentCapture) {
  if (isNonPSAUnsupportedSlabCapture(capture)) {
    return unsupportedSlabTitle;
  }

  return capturePrimaryLabel(capture.mode);
}

export function captureFailureSubtitle(capture: RecentCapture) {
  if (isNonPSAUnsupportedSlabCapture(capture)) {
    return unsupportedSlabSubtitle;
  }

  const reviewReason = capture.matchReviewReason?.trim();
  if (reviewReason) {
    return reviewReason;
  }

  return 'Photo captured, but matches could not load. Please try again.';
}

export function activeCandidateForCapture(capture: RecentCapture) {
  return capture.candidates[capture.activeCandidateIndex] ?? null;
}

export function buildScanSelectionProperties(capture: RecentCapture) {
  return {
    candidate_count: capture.candidates.length,
    mode: capture.mode,
    selection_rank: capture.activeCandidateIndex + 1,
  };
}

export function buildScanMatchSuccessProperties(params: {
  candidateCount: number;
  captureMs?: number | null;
  endToEndMs?: number | null;
  mode: ScannerMode;
  normalizeMs?: number | null;
  persistCopyQueuedAfterPaintMs?: number | null;
  requestAttemptCount?: number | null;
  reviewDisposition?: string | null;
  roundTripMs?: number | null;
  slabAnalysisMs?: number | null;
  serverProcessingMs?: number | null;
}) {
  const properties: Record<string, number | string> = {
    candidate_count: params.candidateCount,
    mode: params.mode,
  };

  if (typeof params.requestAttemptCount === 'number') {
    properties.request_attempt_count = params.requestAttemptCount;
  }

  if (typeof params.captureMs === 'number') {
    properties.capture_ms = params.captureMs;
  }

  if (typeof params.normalizeMs === 'number') {
    properties.normalize_ms = params.normalizeMs;
  }

  if (typeof params.slabAnalysisMs === 'number') {
    properties.slab_analysis_ms = params.slabAnalysisMs;
  }

  if (typeof params.endToEndMs === 'number') {
    properties.end_to_end_ms = params.endToEndMs;
  }

  if (typeof params.reviewDisposition === 'string' && params.reviewDisposition.length > 0) {
    properties.review_disposition = params.reviewDisposition;
  }

  if (typeof params.roundTripMs === 'number') {
    properties.round_trip_ms = params.roundTripMs;
  }

  if (typeof params.serverProcessingMs === 'number') {
    properties.server_processing_ms = params.serverProcessingMs;
  }

  // Hot-path guard: delta between painting the result and queueing the
  // post-paint persistence copy. Expected <5ms; a sustained rise here means
  // persistence work has crept onto the scan hot path.
  if (typeof params.persistCopyQueuedAfterPaintMs === 'number') {
    properties.persist_copy_queued_after_paint_ms = params.persistCopyQueuedAfterPaintMs;
  }

  return properties;
}

export function buildScanMatchFailureProperties(params: {
  captureMs?: number | null;
  endToEndMs?: number | null;
  errorKind: string;
  mode: ScannerMode;
  normalizeMs?: number | null;
  slabAnalysisMs?: number | null;
}) {
  const properties: Record<string, number | string> = {
    error_kind: params.errorKind,
    mode: params.mode,
  };

  if (typeof params.captureMs === 'number') {
    properties.capture_ms = params.captureMs;
  }

  if (typeof params.normalizeMs === 'number') {
    properties.normalize_ms = params.normalizeMs;
  }

  if (typeof params.slabAnalysisMs === 'number') {
    properties.slab_analysis_ms = params.slabAnalysisMs;
  }

  if (typeof params.endToEndMs === 'number') {
    properties.end_to_end_ms = params.endToEndMs;
  }

  return properties;
}

export function formatCurrency(amount: number, currencyCode = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function isFinitePrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Minimal shape of a scan price-sheet selection needed to price a tray row.
 * `ScanPriceSheetSelection` is structurally assignable to this; the structural
 * type is declared here on purpose so this module never imports
 * `scan-price-sheet` (which imports THIS module for `formatCurrency`).
 */
export type ScanTrayPriceSelection = {
  marketPrice: number | null;
};

/** The price one tray row actually shows, with the currency it is quoted in. */
export type ScanTrayPrice = {
  /** Null when the row has no usable price and renders an em-dash. */
  amount: number | null;
  currencyCode: string;
};

/**
 * The only currency the scan tray can price in today — the product is USD-only.
 * Declared once, and always read back from the price/summary rather than
 * re-typed as a literal at a render site: the original bug was exactly that
 * drift, where rows passed an explicit currency and the header leaned on
 * `formatCurrency`'s implicit `'USD'` default. Multi-currency is a planned
 * direction, so amount and currency travel together throughout this module to
 * keep that change localized.
 */
export const supportedTrayCurrencyCode = 'USD';

/**
 * THE single price-resolution rule for a scan-tray capture.
 *
 * Both the per-row price cell and the tray header TOTAL must go through this.
 * Dealers price a stack off the header total, so a row and the total disagreeing
 * is a trust-destroying defect — previously the row honored the price-sheet
 * selection (e.g. the Lightly Played comp) while the total summed the raw
 * candidate market price, and any non-NM selection made them disagree.
 */
export function resolveCaptureTrayPrice(
  capture: RecentCapture,
  selection: ScanTrayPriceSelection | null | undefined,
): ScanTrayPrice {
  const candidate = activeCandidateForCapture(capture);
  // A candidate that reports no currency is taken as the tray's own currency —
  // named, not a bare 'USD' literal, so the assumption is greppable.
  const currencyCode = candidate?.currencyCode ?? supportedTrayCurrencyCode;

  if (isFinitePrice(selection?.marketPrice)) {
    return { amount: selection.marketPrice, currencyCode };
  }

  const candidateMarketPrice = candidate?.marketPrice;
  return {
    amount: isFinitePrice(candidateMarketPrice) ? candidateMarketPrice : null,
    currencyCode,
  };
}

export type TrayPriceSummary = {
  /** Currency the total is denominated in. Render this — never a literal. */
  currencyCode: string;
  /**
   * Distinct currencies (sorted) that were DROPPED from the total because the
   * tray cannot price them yet. Empty in the normal case.
   */
  unsupportedCurrencyCodes: string[];
  total: number;
};

/**
 * Sum the prices the tray rows actually display.
 *
 * Two exclusions, both deliberate:
 * - Captures with no finite price (still matching, no match, or a matched card
 *   with no market price — the rows that render an em-dash) contribute nothing
 *   rather than counting as zero.
 * - Captures priced in a currency the tray doesn't support are dropped and
 *   reported instead of being added in. Folding a ¥4,000 row into a USD sum
 *   would overstate it by roughly 25x, and a dealer pricing inventory could act
 *   on that number financially — silently wrong is the worst outcome here.
 */
export function summarizeTrayPrices(prices: readonly ScanTrayPrice[]): TrayPriceSummary {
  const unsupportedCurrencyCodes = new Set<string>();
  let total = 0;

  prices.forEach(({ amount, currencyCode }) => {
    if (!isFinitePrice(amount)) {
      return;
    }
    if (currencyCode !== supportedTrayCurrencyCode) {
      unsupportedCurrencyCodes.add(currencyCode);
      return;
    }
    total += amount;
  });

  return {
    currencyCode: supportedTrayCurrencyCode,
    total,
    unsupportedCurrencyCodes: [...unsupportedCurrencyCodes].sort(),
  };
}

/** Header TOTAL text for a tray summary, in the summary's own currency. */
export function formatTrayTotal(summary: TrayPriceSummary): string {
  return formatCurrency(summary.total, summary.currencyCode);
}

/**
 * Build a complete optimistic {@link InventoryCardEntry} from a matched scan
 * candidate. `id` should be the REAL inventory entry id from the create response
 * so a later collection refetch reconciles (dedupes) by id; pass a temp
 * `optimistic|...` id only when no server id is available yet.
 */
export function buildOptimisticInventoryEntry(
  candidate: CatalogSearchResult,
  addedAt: string,
  options: {
    mode: ScannerMode;
    slabContext: SlabContext | null;
  },
  id: string,
): InventoryCardEntry {
  const slabContext = options.slabContext;
  const isSlab = options.mode === 'slabs';

  return {
    addedAt,
    cardId: candidate.cardId,
    cardNumber: candidate.cardNumber,
    conditionCode: isSlab ? null : 'near_mint',
    conditionLabel: isSlab ? null : 'Near Mint',
    conditionShortLabel: isSlab ? null : 'NM',
    costBasisPerUnit: null,
    costBasisTotal: 0,
    currencyCode: candidate.currencyCode ?? 'USD',
    hasMarketPrice: candidate.marketPrice != null,
    id,
    imageUrl: candidate.imageUrl,
    kind: isSlab ? 'graded' : 'raw',
    marketPrice: candidate.marketPrice ?? 0,
    name: candidate.name,
    quantity: 1,
    setName: candidate.setName,
    slabContext,
    isFavorite: candidate.isFavorite,
    variantName: slabContext?.variantName ?? null,
  };
}

export function withOptimisticInventoryAdd(
  entries: InventoryCardEntry[],
  candidate: CatalogSearchResult,
  addedAt: string,
  options: {
    mode: ScannerMode;
    slabContext: SlabContext | null;
  },
): InventoryCardEntry[] {
  const slabContext = options.slabContext;
  const isSlab = options.mode === 'slabs';
  const existingIndex = entries.findIndex((entry) => (
    entry.cardId === candidate.cardId
    && (
      isSlab
        ? entry.kind === 'graded' && sameSlabContext(entry.slabContext ?? null, slabContext)
        : entry.kind === 'raw'
          && (entry.conditionCode ?? 'near_mint') === 'near_mint'
          && !entry.variantName
    )
  ));

  if (existingIndex >= 0) {
    return entries.map((entry, index) => (
      index === existingIndex
        ? { ...entry, quantity: entry.quantity + 1 }
        : entry
    ));
  }

  const optimisticId = isSlab
    ? `optimistic|graded|${candidate.cardId}|${slabContext?.grader ?? 'unknown'}|${slabContext?.grade ?? 'unknown'}|${slabContext?.certNumber ?? 'uncertified'}`
    : `optimistic|raw|${candidate.cardId}`;

  return [
    buildOptimisticInventoryEntry(candidate, addedAt, options, optimisticId),
    ...entries,
  ];
}

export function withUpdatedInventoryFavoriteState(
  entries: InventoryCardEntry[],
  cardId: string,
  isFavorite: boolean,
) {
  return entries.map((entry) => (
    entry.cardId === cardId
      ? { ...entry, isFavorite }
      : entry
  ));
}

export function withUpdatedCaptureFavoriteState(
  captures: RecentCapture[],
  cardId: string,
  isFavorite: boolean,
) {
  return captures.map((capture) => ({
    ...capture,
    candidates: capture.candidates.map((candidate) => (
      candidate.cardId === cardId
        ? { ...candidate, isFavorite }
        : candidate
    )),
  }));
}

export function normalizeSlabText(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeSlabNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeSlabTextList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const normalized = normalizeSlabText(entry);
    return normalized ? [normalized] : [];
  });
}

export function sameSlabContext(left: SlabContext | null, right: SlabContext | null) {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    normalizeSlabText(left.grader)?.toUpperCase() === normalizeSlabText(right.grader)?.toUpperCase()
    && normalizeSlabText(left.grade) === normalizeSlabText(right.grade)
    && normalizeSlabText(left.certNumber) === normalizeSlabText(right.certNumber)
    && normalizeSlabText(left.variantName) === normalizeSlabText(right.variantName)
  );
}

export function normalizeScannerSlabAnalysis(
  value: ScannerSlabAnalysisPayload | null | undefined,
): ScannerSlabAnalysisPayload {
  return {
    slabGrader: normalizeSlabText(value?.slabGrader),
    slabGrade: normalizeSlabText(value?.slabGrade),
    slabCertNumber: normalizeSlabText(value?.slabCertNumber),
    slabBarcodePayloads: normalizeSlabTextList(value?.slabBarcodePayloads),
    slabParsedLabelText: normalizeSlabTextList(value?.slabParsedLabelText),
    slabCardNumberRaw: normalizeSlabText(value?.slabCardNumberRaw),
    slabGraderConfidence: normalizeSlabNumber(value?.slabGraderConfidence),
    slabGradeConfidence: normalizeSlabNumber(value?.slabGradeConfidence),
    slabCertConfidence: normalizeSlabNumber(value?.slabCertConfidence),
    slabClassifierReasons: normalizeSlabTextList(value?.slabClassifierReasons),
    slabRecommendedLookupPath: value?.slabRecommendedLookupPath ?? null,
    ocrAnalysis: value?.ocrAnalysis ?? null,
  };
}

export async function analyzeSlabCapture(imageUri: string): Promise<ScannerSlabAnalysisPayload> {
  const result = await analyzePSASlabCapture(imageUri);
  if (result.parsed.unsupportedReason === 'non_psa_slab_not_supported_yet') {
    throw new Error('psa_only_for_now');
  }

  if (!result) {
    throw new Error('slab_analysis_empty');
  }

  return normalizeScannerSlabAnalysis(result.scannerMatchFields);
}

export function slabContextFromAnalysis(analysis: ScannerSlabAnalysisPayload): SlabContext | null {
  const grader = normalizeSlabText(analysis.slabGrader);
  if (!grader) {
    return null;
  }

  const grade = normalizeSlabText(analysis.slabGrade);
  const certNumber = normalizeSlabText(analysis.slabCertNumber);
  return {
    grader,
    grade,
    certNumber,
    variantName: grade ? `${grader} ${grade}` : grader,
  };
}

export function scannerSlabInlineLabel(capture: RecentCapture) {
  const grader = normalizeSlabText(capture.slabContext?.grader);
  const grade = normalizeSlabText(capture.slabContext?.grade);
  if (grader && grade) {
    return `${grader} • ${grade}`;
  }
  return grader ?? normalizeSlabText(capture.slabContext?.variantName);
}

export function scannerSlabSubtitle(capture: RecentCapture, candidate: CatalogSearchResult) {
  void capture;
  return [candidate.cardNumber?.trim(), candidate.setName].filter(Boolean).join(' • ');
}

export function scannerCapturePriceLabel(capture: RecentCapture) {
  void capture;
  return 'MARKET';
}

export function scannerCaptureThumbUri(capture: RecentCapture, candidate: CatalogSearchResult | null) {
  if (capture.mode === 'slabs') {
    return candidate?.smallImageUrl || candidate?.imageUrl || capture.uri || null;
  }

  // Raw lane: while identifying (no candidate yet) prefer the reticle-cropped
  // `normalizedImageUri` over the full `uri` (the un-cropped source photo) so the
  // tray thumbnail shows the framed card, not a zoomed-out frame. Matches what the
  // "change card" modal renders (`normalizedImageUri ?? uri`). Prefer the small
  // candidate image so bad-wifi tray thumbnails don't pull full-res art.
  // When the source photo needs rotation (Android camera2 writes the file
  // landscape), never show it raw — a beat of placeholder beats a sideways
  // card that snaps upright when normalization lands.
  const sourceUri = capture.sourceImageRotationDegrees ? null : capture.uri;
  return (
    candidate?.smallImageUrl
    || candidate?.imageUrl
    || capture.normalizedImageUri
    || sourceUri
    || null
  );
}

/**
 * The subtitle a failed match shows, when the failure is explainable by the
 * LANE it was scanned in.
 *
 * A game whose visual index has not been built yet makes the backend raise at
 * scan time, and that surfaces here as a server error (HTTP 5xx) — an unhandled
 * "matches could not load" would send the user back to the shutter to try the
 * same impossible scan again. Deliberately narrow:
 *
 *  - Pokémon always returns null (its index is eagerly loaded and always
 *    present; a 500 there is a real backend fault, not a missing lane), so the
 *    Pokémon failure copy is untouched.
 *  - Only SERVER errors qualify. A timeout or an offline phone carries no
 *    status, and blaming the lane for those would be a lie the user acts on.
 */
export function scannerLaneUnavailableReason(
  game: CardGame | undefined,
  error: unknown,
): string | null {
  if ((game ?? DEFAULT_CARD_GAME) === DEFAULT_CARD_GAME) {
    return null;
  }
  if (!isSpotlightRepositoryRequestError(error)) {
    return null;
  }
  if (typeof error.status !== 'number' || error.status < 500) {
    return null;
  }
  return `${gameDisplayName(game)} scanning isn't available yet. Switch lanes and try again.`;
}

export function scannerPreparationReviewReason(mode: ScannerMode, error: unknown) {
  if (mode !== 'slabs') {
    return null;
  }

  const errorKind = scannerErrorKind(error);
  switch (errorKind) {
    case 'native_module_unavailable':
    case 'unsupported_platform':
      return 'Slab analysis is unavailable on this build.';
    case 'invalid_image_uri':
      return 'Could not prepare this slab capture for analysis.';
    case 'native_analysis_failed':
      return 'Could not read this slab label strongly enough.';
    case 'slab_analysis_empty':
      return 'Could not read this slab label strongly enough.';
    case 'normalized_target_unavailable':
      return 'Could not isolate the PSA label inside the guide.';
    case 'psa_only_for_now':
      return unsupportedSlabSubtitle;
    default:
      return error instanceof Error && error.message.trim().length > 0
        ? error.message.trim()
        : 'Could not analyze this slab label.';
  }
}

export async function triggerScannerHaptic() {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  // Android: expo-haptics "Heavy" maps to a weak OEM effect (Samsung fires it
  // at ~27% amplitude — barely felt). The raw Vibration API runs the motor at
  // full amplitude; budget motors also need LONGER pulses to register, so the
  // shutter is a firm double "ka-chunk": 60ms, 70ms gap, 60ms.
  if (Platform.OS === 'android') {
    Vibration.vibrate([0, 60, 70, 60]);
    return;
  }

  try {
    // Heavy impact for the shutter: the capture should be unmistakably FELT (a
    // firm "ka-chunk"), like an iOS screenshot. Light read as barely-there.
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  } catch (error) {
    // ExpoHaptics native module likely isn't active in this binary (OTA can't add
    // native code). Fall back to the CORE Vibration API, which is always compiled
    // in, so the capture is still FELT. On iOS the ms arg is ignored but it still
    // fires the system vibration — it is NOT a no-op (earlier belief was wrong).
    console.warn('[scanner] capture haptic unavailable (native module missing?)', error);
    Vibration.vibrate(25);
  }
}

// Module-level so rapid back-to-back scans (e.g. card-show bursts) collapse
// to one rumble. 300 ms is short enough that normal-paced scans always fire
// and long enough that a 3-tap-in-1s burst feels like a single confirmation.
const PROCESSED_HAPTIC_DEBOUNCE_MS = 300;
let lastProcessedHapticAt = 0;

// Second buzz, fired when a scan resolves. For a found card we punch it up: a
// Heavy impact immediately followed by a Success NOTIFICATION pattern, so the
// "got it!" is strongly felt and reads as a clear, separate beat from the Heavy
// capture shutter (not blurred into one on a fast match). Other outcomes
// (no match / unsupported) get a Medium tick — present but not celebratory.
export async function triggerScannerProcessedHaptic(outcome: 'found' | 'done' = 'done') {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  const now = Date.now();
  if (now - lastProcessedHapticAt < PROCESSED_HAPTIC_DEBOUNCE_MS) {
    return;
  }
  lastProcessedHapticAt = now;

  // Android: same weak-OEM-effect story as the shutter — use full-amplitude
  // raw vibration. "found" = quick double tap, "done" = single short tap.
  if (Platform.OS === 'android') {
    Vibration.vibrate(outcome === 'found' ? [0, 45, 60, 45] : 30);
    return;
  }

  try {
    if (outcome === 'found') {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  } catch (error) {
    console.warn('[scanner] result haptic unavailable (native module missing?)', error);
    // Core Vibration fallback (always compiled in) so the result is felt on iOS
    // and Android even when the ExpoHaptics native module isn't in the binary.
    Vibration.vibrate(outcome === 'found' ? [0, 45, 60, 45] : 15);
  }
}

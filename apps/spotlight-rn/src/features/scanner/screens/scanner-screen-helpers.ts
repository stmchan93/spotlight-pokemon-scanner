import { Platform, Vibration } from 'react-native';

import {
  isSpotlightRepositoryRequestError,
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

  return 'Photo captured, but matches could not load';
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
  artifactUploadMs?: number | null;
  candidateCount: number;
  captureMs?: number | null;
  endToEndMs?: number | null;
  mode: ScannerMode;
  normalizeMs?: number | null;
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

  if (typeof params.artifactUploadMs === 'number') {
    properties.artifact_upload_ms = params.artifactUploadMs;
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

  return [
    {
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
      id: isSlab
        ? `optimistic|graded|${candidate.cardId}|${slabContext?.grader ?? 'unknown'}|${slabContext?.grade ?? 'unknown'}|${slabContext?.certNumber ?? 'uncertified'}`
        : `optimistic|raw|${candidate.cardId}`,
      imageUrl: candidate.imageUrl,
      kind: isSlab ? 'graded' : 'raw',
      marketPrice: candidate.marketPrice ?? 0,
      name: candidate.name,
      quantity: 1,
      setName: candidate.setName,
      slabContext,
      isFavorite: candidate.isFavorite,
      variantName: slabContext?.variantName ?? null,
    },
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
    return candidate?.imageUrl || capture.uri || null;
  }

  return candidate?.imageUrl || capture.uri || null;
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

  try {
    const Haptics = await import('expo-haptics');
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  } catch {
    if (Platform.OS !== 'web') {
      Vibration.vibrate(10);
    }
  }
}

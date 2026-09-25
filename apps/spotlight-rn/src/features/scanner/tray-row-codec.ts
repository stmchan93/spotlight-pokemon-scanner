import type { ScanPriceSheetSelection } from './screens/scan-price-sheet';
import type { RecentCapture } from './screens/scanner-screen-types';
import type { TrayRowRead, TrayRowWrite } from './tray-db';

/** The durable part of a tray row. Session-only flags are rebuilt on load. */
export type PersistedCapture = Pick<RecentCapture,
  | 'id'
  | 'scanID'
  | 'mode'
  | 'uri'
  | 'normalizedImageUri'
  | 'candidates'
  | 'activeCandidateIndex'
  | 'totalCandidateCount'
  | 'matchReviewDisposition'
  | 'matchReviewReason'
  | 'slabContext'
  | 'normalizedImageDimensions'
  | 'sourceImageCrop'
  | 'sourceImageDimensions'
  | 'sourceImageRotationDegrees'
  | 'binderPage'
  | 'matchConfidence'
>;

export function toPersistedCapture(capture: RecentCapture): PersistedCapture {
  return {
    id: capture.id,
    scanID: capture.scanID,
    mode: capture.mode,
    uri: capture.uri,
    normalizedImageUri: capture.normalizedImageUri,
    // Every candidate, including pages the change-card picker loaded.
    candidates: capture.candidates,
    activeCandidateIndex: capture.activeCandidateIndex,
    totalCandidateCount: capture.totalCandidateCount,
    matchReviewDisposition: capture.matchReviewDisposition,
    matchReviewReason: capture.matchReviewReason,
    slabContext: capture.slabContext,
    normalizedImageDimensions: capture.normalizedImageDimensions,
    sourceImageCrop: capture.sourceImageCrop,
    sourceImageDimensions: capture.sourceImageDimensions,
    sourceImageRotationDegrees: capture.sourceImageRotationDegrees,
    binderPage: capture.binderPage ?? null,
    matchConfidence: capture.matchConfidence ?? null,
  };
}

export function fromPersistedCapture(persisted: PersistedCapture): RecentCapture {
  return {
    ...persisted,
    // Defensive clamp: a row written by an older/partial code path (legacy
    // envelopes trimmed candidates) must never point past its own array.
    activeCandidateIndex: Math.min(
      Math.max(0, persisted.activeCandidateIndex),
      Math.max(0, persisted.candidates.length - 1),
    ),
    // Older rows predate totalCandidateCount; fall back to what we have.
    totalCandidateCount: persisted.totalCandidateCount ?? persisted.candidates.length,
    isLoadingMoreCandidates: false,
    hasTrackedSelectionEvent: false,
    // Restored rows have no honest dwell anchor: the clock started in a prior
    // session, so the terminal event omits dwell rather than inventing one.
    shownAtMs: null,
    isAddingToInventory: false,
    isLoadingCandidates: false,
    recentlyAdded: false,
  };
}

export function isPersistableItem(capture: RecentCapture): boolean {
  // Skip in-flight scans: they're still loading and rehydrating them after a
  // force-quit would leave a permanently spinning row. Also skip items missing
  // a normalized image — there's nothing to anchor the rehydrated row to.
  return !capture.isLoadingCandidates && Boolean(capture.normalizedImageUri);
}

export function isPersistedCapture(value: unknown): value is PersistedCapture {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as PersistedCapture;
  return (
    typeof candidate.id === 'string'
    && (candidate.mode === 'raw' || candidate.mode === 'slabs')
    && Array.isArray(candidate.candidates)
    && typeof candidate.activeCandidateIndex === 'number'
  );
}

export function isPersistedPriceSelection(value: unknown): value is ScanPriceSheetSelection {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const selection = value as ScanPriceSheetSelection;
  return (
    typeof selection.variantKey === 'string'
    && typeof selection.variantLabel === 'string'
    && typeof selection.conditionCode === 'string'
    && typeof selection.conditionShortLabel === 'string'
    && (selection.marketPrice === null || typeof selection.marketPrice === 'number')
  );
}

export function trayRowWriteFor(
  persisted: PersistedCapture,
  selection: ScanPriceSheetSelection | null,
  sortKey: number,
): TrayRowWrite {
  const active = persisted.candidates[persisted.activeCandidateIndex] ?? null;
  return {
    id: persisted.id,
    sortKey,
    mode: persisted.mode,
    normalizedImageUri: persisted.normalizedImageUri ?? null,
    sourceImageUri: persisted.uri || null,
    binderPageId: persisted.binderPage?.pageId ?? null,
    activeCardId: active?.cardId ?? null,
    activeCardName: active?.name ?? null,
    captureJson: JSON.stringify(persisted),
    priceSelectionJson: selection ? JSON.stringify(selection) : null,
  };
}

/** A stored row back as a tray capture, or null if it no longer parses. */
export function decodeTrayRow(
  row: TrayRowRead,
): { capture: RecentCapture; selection: ScanPriceSheetSelection | null } | null {
  try {
    const persisted: unknown = JSON.parse(row.captureJson);
    if (!isPersistedCapture(persisted) || persisted.id !== row.id) {
      return null;
    }
    const selection: unknown = row.priceSelectionJson ? JSON.parse(row.priceSelectionJson) : null;
    return {
      capture: fromPersistedCapture(persisted),
      selection: isPersistedPriceSelection(selection) ? selection : null,
    };
  } catch {
    return null;
  }
}

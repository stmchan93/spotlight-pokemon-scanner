import type { CatalogSearchResult, SlabContext } from '@spotlight/api-client';

export type ScanImageDimensions = {
  height: number;
  width: number;
};

export type ScanSourceImageDimensions = ScanImageDimensions;

export type ScanSourceImageCrop = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type ScanCandidateReviewSession = {
  candidates: CatalogSearchResult[];
  id: string;
  normalizedImageDimensions: ScanImageDimensions | null;
  normalizedImageUri: string | null;
  selectedCardId: string;
  slabContext?: SlabContext | null;
  sourceImageCrop?: ScanSourceImageCrop | null;
  sourceImageDimensions?: ScanSourceImageDimensions | null;
  sourceImageRotationDegrees?: number;
  sourceImageUri?: string | null;
};

const maxStoredSessions = 20;
const sessions = new Map<string, ScanCandidateReviewSession>();

type SaveScanCandidateReviewSessionInput = {
  candidates: CatalogSearchResult[];
  id: string;
  normalizedImageDimensions?: ScanImageDimensions | null;
  normalizedImageUri?: string | null;
  sourceImageCrop?: ScanSourceImageCrop | null;
  selectedCardId: string;
  slabContext?: SlabContext | null;
  sourceImageDimensions?: ScanSourceImageDimensions | null;
  sourceImageRotationDegrees?: number;
  sourceImageUri?: string | null;
};

export function saveScanCandidateReviewSession({
  candidates,
  id,
  normalizedImageDimensions = null,
  normalizedImageUri = null,
  sourceImageCrop = null,
  selectedCardId,
  slabContext = null,
  sourceImageDimensions = null,
  sourceImageRotationDegrees = 0,
  sourceImageUri = null,
}: SaveScanCandidateReviewSessionInput) {
  const session: ScanCandidateReviewSession = {
    candidates: candidates.slice(0, 10),
    id,
    normalizedImageDimensions,
    normalizedImageUri,
    slabContext,
    sourceImageCrop,
    selectedCardId,
    sourceImageDimensions,
    sourceImageRotationDegrees,
    sourceImageUri,
  };

  sessions.delete(id);
  sessions.set(id, session);

  while (sessions.size > maxStoredSessions) {
    const oldestKey = sessions.keys().next().value;
    if (!oldestKey) {
      break;
    }
    sessions.delete(oldestKey);
  }

  return id;
}

export function getScanCandidateReviewSession(id?: string | null) {
  if (!id) {
    return null;
  }

  return sessions.get(id) ?? null;
}

export function clearScanCandidateReviewSessions() {
  sessions.clear();
}

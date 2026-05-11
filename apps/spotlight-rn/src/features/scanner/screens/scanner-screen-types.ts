import type {
  CatalogSearchResult,
  ScannerCapturePayload,
  SlabContext,
} from '@spotlight/api-client';

import type {
  ScanSourceImageCrop,
  ScanSourceImageDimensions,
} from '@/features/scanner/scan-candidate-review-session';
import type { NormalizedScannerTarget } from '@/features/scanner/scanner-normalized-target';

export type ScannerMode = 'raw' | 'slabs';

export type RecentCapture = {
  candidates: CatalogSearchResult[];
  hasTrackedSelectionEvent: boolean;
  id: string;
  isAddingToInventory: boolean;
  isLoadingCandidates: boolean;
  matchReviewDisposition: string | null;
  matchReviewReason: string | null;
  mode: ScannerMode;
  normalizedImageDimensions: ScanSourceImageDimensions | null;
  normalizedImageUri: string | null;
  scanID: string | null;
  slabContext: SlabContext | null;
  sourceImageCrop: ScanSourceImageCrop | null;
  sourceImageDimensions: ScanSourceImageDimensions | null;
  sourceImageRotationDegrees: number;
  uri: string;
  activeCandidateIndex: number;
};

export type CaptureMatchParams = {
  captureId: string;
  captureMs: number;
  captureSource: 'camera' | 'smoke_fixture';
  matchPayload: ScannerCapturePayload;
  matchTarget: NormalizedScannerTarget;
  mode: ScannerMode;
  normalizeMs: number;
  rawSourceImageDimensions: ScanSourceImageDimensions;
  scanStartedAt: number;
  slabAnalysisMs?: number | null;
  sourceImageDimensions: ScanSourceImageDimensions;
};

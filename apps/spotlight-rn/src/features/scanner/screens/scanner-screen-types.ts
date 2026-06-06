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
  recentlyAdded: boolean;
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
  /** Total candidates available for this scan on the backend; drives "load more". */
  totalCandidateCount: number;
  /** True while a "load more candidates" page request is in flight. */
  isLoadingMoreCandidates: boolean;
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
  /**
   * Phase 2 raw collector-number OCR (SECONDARY verification). Started by the
   * capture handler so it runs CONCURRENTLY with the network match work; the
   * resolved value is merged into the payload as
   * `ocrAnalysis.rawEvidence.collectorNumberExact` before the request body is
   * built. Resolves to null when disabled / unavailable / no number read.
   */
  rawCollectorNumberPromise?: Promise<string | null> | null;
};

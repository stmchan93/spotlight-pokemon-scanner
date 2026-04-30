import type {
  CatalogSearchResult,
  LabelingSessionAngleLabel,
  LabelingSessionArtifactRecord,
  LabelingSessionArtifactUploadPayload,
  LabelingSessionCreatePayload,
  LabelingSessionRecord,
  SpotlightRepository,
} from '@spotlight/api-client';

import type {
  ScanSourceImageCrop,
  ScanSourceImageDimensions,
} from '@/features/scanner/scan-candidate-review-session';

export type {
  LabelingSessionAngleLabel,
  LabelingSessionArtifactRecord,
  LabelingSessionArtifactUploadPayload,
  LabelingSessionCreatePayload,
  LabelingSessionRecord,
};

export type LabelingSessionImagePayload = {
  jpegBase64: string;
  uri: string;
  width: number;
  height: number;
};

export type LabelingSessionArtifactMetadata = {
  sourceImageCrop: ScanSourceImageCrop;
  sourceImageDimensions: ScanSourceImageDimensions;
  nativeSourceImageDimensions: ScanSourceImageDimensions;
  normalizationRotationDegrees: number;
  normalizedImageDimensions: ScanSourceImageDimensions;
};

export type LabelingSessionRepository = SpotlightRepository & {
  createLabelingSession(payload: LabelingSessionCreatePayload): Promise<LabelingSessionRecord>;
  uploadLabelingSessionArtifact(
    payload: LabelingSessionArtifactUploadPayload,
  ): Promise<LabelingSessionArtifactRecord>;
  completeLabelingSession(
    sessionID: string,
    payload?: { completedAt?: string | null },
  ): Promise<LabelingSessionRecord>;
  abortLabelingSession(
    sessionID: string,
    payload?: { abortedAt?: string | null },
  ): Promise<LabelingSessionRecord>;
};

export type LabelingSessionCapture = {
  angleLabel: LabelingSessionAngleLabel;
  angleIndex: number;
  card: CatalogSearchResult;
  capturedAt: string;
  sourceCapture: LabelingSessionImagePayload;
  normalizedTarget: LabelingSessionImagePayload;
  thumbnailUri: string;
  metadata: LabelingSessionArtifactMetadata;
};

export function asLabelingSessionRepository(
  repository: SpotlightRepository,
): LabelingSessionRepository {
  return repository as LabelingSessionRepository;
}

export function getLabelingSessionID(record: LabelingSessionRecord) {
  return record.sessionID ?? null;
}

export function assertLabelingSessionRepository(
  repository: SpotlightRepository,
): asserts repository is LabelingSessionRepository {
  const maybeRepository = repository as Partial<LabelingSessionRepository>;
  if (
    typeof maybeRepository.createLabelingSession !== 'function'
    || typeof maybeRepository.uploadLabelingSessionArtifact !== 'function'
    || typeof maybeRepository.completeLabelingSession !== 'function'
    || typeof maybeRepository.abortLabelingSession !== 'function'
  ) {
    throw new Error('Labeling session API methods are not available in the current API client.');
  }
}

import { useEffect, useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import {
  resolveActiveScanReviewCandidate,
  resolveSimilarScanCandidates,
  ScanCandidateReviewScreen,
} from '@/features/cards/screens/scan-candidate-review-screen';
import { getScanCandidateReviewSession } from '@/features/scanner/scan-candidate-review-session';

function firstParam(value?: string | string[]) {
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate.trim().length > 0) ?? '';
  }

  return value ?? '';
}

export default function ScanCandidateReviewRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    cardId?: string | string[];
    scanReviewId?: string | string[];
  }>();
  const cardId = firstParam(params.cardId);
  const scanReviewId = firstParam(params.scanReviewId) || undefined;
  const scanReviewSession = useMemo(
    () => getScanCandidateReviewSession(scanReviewId),
    [scanReviewId],
  );
  const closestMatch = useMemo(
    () => resolveActiveScanReviewCandidate(scanReviewSession, cardId),
    [cardId, scanReviewSession],
  );
  const similarCandidates = useMemo(
    () => resolveSimilarScanCandidates(scanReviewSession, closestMatch?.cardId ?? cardId),
    [cardId, closestMatch?.cardId, scanReviewSession],
  );

  useEffect(() => {
    if (!cardId || !scanReviewSession || similarCandidates.length === 0) {
      router.back();
    }
  }, [cardId, router, scanReviewSession, similarCandidates.length]);

  if (!cardId || !scanReviewSession || similarCandidates.length === 0) {
    return null;
  }

  return (
    <ScanCandidateReviewScreen
      closestMatch={closestMatch}
      candidates={similarCandidates}
      onBack={() => router.back()}
      onOpenCandidate={(candidate) => {
        if (candidate.cardId === cardId) {
          router.back();
          return;
        }

        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId: candidate.cardId,
            scanReviewId,
          },
        });
      }}
      normalizedImageDimensions={
        scanReviewSession.normalizedImageDimensions
        ?? scanReviewSession.sourceImageDimensions
        ?? null
      }
      normalizedImageUri={scanReviewSession.normalizedImageUri ?? scanReviewSession.sourceImageUri ?? null}
      totalCount={scanReviewSession.candidates.length}
    />
  );
}

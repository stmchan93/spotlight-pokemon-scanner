import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CatalogSearchResult } from '@spotlight/api-client';
import {
  Button,
  SearchField,
  StateCard,
  SurfaceCard,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton } from '@/components/chrome-back-button';
import {
  type LabelingSessionAngleLabel,
  type LabelingSessionArtifactUploadPayload,
  type LabelingSessionCapture,
  assertLabelingSessionRepository,
  getLabelingSessionID,
} from '@/features/labeling/labeling-session-api';
import type {
  ScanSourceImageCrop,
  ScanSourceImageDimensions,
} from '@/features/scanner/scan-candidate-review-session';
import {
  buildNormalizedScannerTarget,
  makeOrientationFixedSourceImageDimensions,
} from '@/features/scanner/scanner-normalized-target';
import {
  chooseRawVisualPictureSize,
  makeRawScannerCaptureLayout,
  RawScannerCaptureSurface,
  rawScannerTrayReservedHeight,
  rawVisualCaptureQuality,
} from '@/features/scanner/raw-scanner-capture-surface';
import { capturePostHogEvent } from '@/lib/observability/posthog';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

type LabelingStep = 'search' | 'confirm' | 'capture' | 'review' | 'done';

type CameraPicture = {
  base64?: string;
  height?: number;
  uri?: string;
  width?: number;
};

const requiredAngles = [
  { label: 'front', title: 'Front' },
  { label: 'tilt_left', title: 'Tilt left' },
  { label: 'tilt_right', title: 'Tilt right' },
  { label: 'tilt_forward', title: 'Tilt forward' },
] as const satisfies readonly { label: LabelingSessionAngleLabel; title: string }[];

function cardNumberLabel(card: CatalogSearchResult) {
  return card.cardNumber.startsWith('#') ? card.cardNumber : `#${card.cardNumber}`;
}

function errorMessageFromUnknown(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Labeling session failed.';
}

function makeUploadPayload(capture: LabelingSessionCapture, sessionID: string): LabelingSessionArtifactUploadPayload {
  return {
    sessionID,
    angleLabel: capture.angleLabel,
    angleIndex: capture.angleIndex,
    submittedAt: capture.capturedAt,
    sourceImage: {
      height: capture.sourceCapture.height,
      jpegBase64: capture.sourceCapture.jpegBase64,
      width: capture.sourceCapture.width,
    },
    normalizedImage: {
      height: capture.normalizedTarget.height,
      jpegBase64: capture.normalizedTarget.jpegBase64,
      width: capture.normalizedTarget.width,
    },
    nativeSourceWidth: capture.metadata.nativeSourceImageDimensions.width,
    nativeSourceHeight: capture.metadata.nativeSourceImageDimensions.height,
    cropX: capture.metadata.sourceImageCrop.x,
    cropY: capture.metadata.sourceImageCrop.y,
    cropWidth: capture.metadata.sourceImageCrop.width,
    cropHeight: capture.metadata.sourceImageCrop.height,
    normalizationRotationDegrees: capture.metadata.normalizationRotationDegrees,
    normalizationReason: 'exact_reticle',
    scannerFrontHalfVersion: 'rn_labeler_session_mvp',
    sourceBranch: 'exact_reticle',
    pixelsPerCardHeight: capture.metadata.sourceImageCrop.height,
    processingMs: null,
  };
}

function CardSummary({
  card,
  compact = false,
}: {
  card: CatalogSearchResult;
  compact?: boolean;
}) {
  const theme = useSpotlightTheme();
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <SurfaceCard
      padding={theme.spacing.sm}
      radius={theme.radii.md}
      style={compact ? styles.cardSummaryCompact : styles.cardSummary}
      testID="labeler-selected-card"
      variant="elevated"
    >
      <View
        style={[
          styles.cardArtFrame,
          {
            backgroundColor: theme.colors.field,
            borderColor: theme.colors.outlineSubtle,
          },
        ]}
      >
        {!imageFailed && card.imageUrl ? (
          <Image
            onError={() => setImageFailed(true)}
            resizeMode="contain"
            source={{ uri: card.imageUrl }}
            style={styles.cardArt}
          />
        ) : (
          <Text
            numberOfLines={2}
            style={[theme.typography.caption, styles.cardArtFallback, { color: theme.colors.textSecondary }]}
          >
            {card.name}
          </Text>
        )}
      </View>

      <View style={styles.cardSummaryCopy}>
        <Text numberOfLines={2} style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
          {card.name}
        </Text>
        <Text numberOfLines={2} style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {card.setName}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {cardNumberLabel(card)}
        </Text>
      </View>
    </SurfaceCard>
  );
}

function SearchResultRow({
  result,
  onPress,
}: {
  result: CatalogSearchResult;
  onPress: () => void;
}) {
  const theme = useSpotlightTheme();

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.resultRow,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.outlineSubtle,
          opacity: pressed ? 0.9 : 1,
        },
      ]}
      testID={`labeler-result-${result.id}`}
    >
      <Image
        resizeMode="contain"
        source={{ uri: result.imageUrl }}
        style={[
          styles.resultImage,
          {
            backgroundColor: theme.colors.field,
            borderColor: theme.colors.outlineSubtle,
          },
        ]}
      />
      <View style={styles.resultCopy}>
        <Text numberOfLines={2} style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
          {result.name}
        </Text>
        <Text numberOfLines={2} style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
          {result.setName}
        </Text>
        <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
          {cardNumberLabel(result)}
        </Text>
      </View>
      <Text style={[theme.typography.titleCompact, { color: theme.colors.textSecondary }]}>›</Text>
    </Pressable>
  );
}

function AngleProgress({
  captures,
  currentAngle,
}: {
  captures: Partial<Record<LabelingSessionAngleLabel, LabelingSessionCapture>>;
  currentAngle?: LabelingSessionAngleLabel;
}) {
  const theme = useSpotlightTheme();

  return (
    <View style={styles.angleProgress}>
      {requiredAngles.map((angle) => {
        const captured = captures[angle.label];
        const selected = angle.label === currentAngle;

        return (
          <View
            key={angle.label}
            style={[
              styles.anglePill,
              {
                backgroundColor: captured
                  ? theme.colors.brand
                  : selected
                    ? theme.colors.surfaceMuted
                    : theme.colors.field,
                borderColor: selected ? theme.colors.brand : theme.colors.outlineSubtle,
              },
            ]}
            testID={`labeler-angle-${angle.label}`}
          >
            <Text
              style={[
                theme.typography.caption,
                {
                  color: captured || selected ? theme.colors.textPrimary : theme.colors.textSecondary,
                },
              ]}
            >
              {angle.title}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function LabelingSessionScreen() {
  const router = useRouter();
  const theme = useSpotlightTheme();
  const { currentUser } = useAuth();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { spotlightRepository } = useAppServices();
  const [permission, requestPermission] = useCameraPermissions();

  const [step, setStep] = useState<LabelingStep>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogSearchResult[]>([]);
  const [selectedCard, setSelectedCard] = useState<CatalogSearchResult | null>(null);
  const [captures, setCaptures] = useState<Partial<Record<LabelingSessionAngleLabel, LabelingSessionCapture>>>({});
  const [currentAngleIndex, setCurrentAngleIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [openSessionID, setOpenSessionID] = useState<string | null>(null);
  const [completedSessionID, setCompletedSessionID] = useState<string | null>(null);
  const [rawVisualPictureSize, setRawVisualPictureSize] = useState<string | undefined>(undefined);
  const cameraRef = useRef<CameraView | null>(null);
  const isResolvingPictureSizeRef = useRef(false);

  const hasLabelingAccess = !!(currentUser?.labelerEnabled || currentUser?.adminEnabled);
  const currentAngle = requiredAngles[currentAngleIndex] ?? requiredAngles[0];
  const captureSurfaceLayout = useMemo(() => makeRawScannerCaptureLayout({
    containerHeight: windowHeight,
    containerWidth: windowWidth,
    safeAreaTop: insets.top,
    trayReservedHeight: rawScannerTrayReservedHeight,
  }), [insets.top, windowHeight, windowWidth]);
  const orderedCaptures = useMemo(() => {
    return requiredAngles
      .map((angle) => captures[angle.label])
      .filter((capture): capture is LabelingSessionCapture => !!capture);
  }, [captures]);
  const hasAllCaptures = orderedCaptures.length === requiredAngles.length;
  const canCapture = !!permission?.granted
    && isCameraReady
    && !!selectedCard
    && !isCapturing;

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setHasSearched(false);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    setHasSearched(false);

    void spotlightRepository.searchCatalogCards(trimmed, 20)
      .then((nextResults) => {
        if (cancelled) {
          return;
        }

        setResults(nextResults);
        setHasSearched(true);
        setErrorMessage('');
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setResults([]);
        setHasSearched(true);
        setErrorMessage(errorMessageFromUnknown(error));
      })
      .finally(() => {
        if (!cancelled) {
          setIsSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [query, spotlightRepository]);

  useEffect(() => {
    if (!permission || permission.granted || !permission.canAskAgain) {
      return;
    }

    void requestPermission();
  }, [permission, requestPermission]);

  const resolveRawVisualPictureSize = useCallback(() => {
    if (isResolvingPictureSizeRef.current) {
      return;
    }

    isResolvingPictureSizeRef.current = true;
    void (async () => {
      try {
        const sizes = await cameraRef.current?.getAvailablePictureSizesAsync?.();
        const selectedSize = chooseRawVisualPictureSize(Array.isArray(sizes) ? sizes : []);
        setRawVisualPictureSize(selectedSize ?? undefined);
      } catch {
        setRawVisualPictureSize(undefined);
      } finally {
        isResolvingPictureSizeRef.current = false;
      }
    })();
  }, []);

  const resetSession = useCallback(() => {
    setStep('search');
    setQuery('');
    setResults([]);
    setSelectedCard(null);
    setCaptures({});
    setCurrentAngleIndex(0);
    setErrorMessage('');
    setOpenSessionID(null);
    setCompletedSessionID(null);
  }, []);

  const handleBack = useCallback(() => {
    if (openSessionID && !completedSessionID) {
      try {
        assertLabelingSessionRepository(spotlightRepository);
        void spotlightRepository.abortLabelingSession(openSessionID, {
          abortedAt: new Date().toISOString(),
        });
      } catch {
        // The session will remain server-visible if the API client is unavailable.
      }
    }

    if (router.canGoBack()) {
      router.back();
      return;
    }

    router.replace('/');
  }, [completedSessionID, openSessionID, router, spotlightRepository]);

  const handleSelectResult = useCallback((result: CatalogSearchResult) => {
    setSelectedCard(result);
    setErrorMessage('');
    setStep('confirm');
  }, []);

  const handleConfirmCard = useCallback(() => {
    setCaptures({});
    setCurrentAngleIndex(0);
    setErrorMessage('');
    setStep('capture');
  }, []);

  const handleRetake = useCallback((label: LabelingSessionAngleLabel) => {
    const index = requiredAngles.findIndex((angle) => angle.label === label);
    setCurrentAngleIndex(index >= 0 ? index : 0);
    setErrorMessage('');
    setStep('capture');
  }, []);

  const handleCapture = useCallback(async () => {
    if (!permission?.granted) {
      if (permission?.canAskAgain) {
        await requestPermission();
      }
      return;
    }

    if (!cameraRef.current || !selectedCard || isCapturing) {
      return;
    }

    setIsCapturing(true);
    setErrorMessage('');

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        exif: false,
        quality: rawVisualCaptureQuality,
        skipProcessing: false,
      }) as CameraPicture | null;

      if (!photo?.uri || !photo.base64) {
        throw new Error('source_capture_unavailable');
      }

      const rawSourceDimensions: ScanSourceImageDimensions = {
        height: photo.height ?? 1,
        width: photo.width ?? 1,
      };
      const sourceImageDimensions = makeOrientationFixedSourceImageDimensions(rawSourceDimensions);
      const normalizedTarget = await buildNormalizedScannerTarget({
        previewLayout: {
          height: captureSurfaceLayout.previewHeight,
          width: captureSurfaceLayout.previewWidth,
        },
        reticle: captureSurfaceLayout.reticle,
        sourceImageDimensions,
        sourceImageUri: photo.uri,
      });

      if (!normalizedTarget) {
        throw new Error('normalized_target_unavailable');
      }

      const sourceImageCrop: ScanSourceImageCrop = normalizedTarget.sourceImageCrop;
      const capture: LabelingSessionCapture = {
        angleIndex: currentAngleIndex + 1,
        angleLabel: currentAngle.label,
        card: selectedCard,
        capturedAt: new Date().toISOString(),
        metadata: {
          nativeSourceImageDimensions: normalizedTarget.nativeSourceImageDimensions,
          normalizationRotationDegrees: normalizedTarget.normalizationRotationDegrees,
          normalizedImageDimensions: normalizedTarget.normalizedImageDimensions,
          sourceImageCrop,
          sourceImageDimensions,
        },
        normalizedTarget: {
          height: normalizedTarget.normalizedImageDimensions.height,
          jpegBase64: normalizedTarget.normalizedImageBase64,
          uri: normalizedTarget.normalizedImageUri,
          width: normalizedTarget.normalizedImageDimensions.width,
        },
        sourceCapture: {
          height: sourceImageDimensions.height,
          jpegBase64: photo.base64,
          uri: photo.uri,
          width: sourceImageDimensions.width,
        },
        thumbnailUri: normalizedTarget.normalizedImageUri,
      };
      const nextCaptures = {
        ...captures,
        [currentAngle.label]: capture,
      };
      const nextMissingIndex = requiredAngles.findIndex((angle) => !nextCaptures[angle.label]);

      setCaptures(nextCaptures);
      if (nextMissingIndex >= 0) {
        setCurrentAngleIndex(nextMissingIndex);
      } else {
        setStep('review');
      }
    } catch (error) {
      setErrorMessage(errorMessageFromUnknown(error));
    } finally {
      setIsCapturing(false);
    }
  }, [
    captures,
    currentAngle.label,
    currentAngleIndex,
    captureSurfaceLayout.previewHeight,
    captureSurfaceLayout.previewWidth,
    captureSurfaceLayout.reticle,
    isCapturing,
    permission,
    requestPermission,
    selectedCard,
  ]);

  const handleDone = useCallback(async () => {
    if (!selectedCard || !hasAllCaptures || isSubmitting) {
      return;
    }

    let createdSessionID: string | null = null;
    setIsSubmitting(true);
    setErrorMessage('');

    try {
      assertLabelingSessionRepository(spotlightRepository);
      const session = await spotlightRepository.createLabelingSession({
        cardID: selectedCard.cardId,
        cardName: selectedCard.name,
        cardNumber: selectedCard.cardNumber,
        createdAt: new Date().toISOString(),
        setName: selectedCard.setName,
      });
      createdSessionID = getLabelingSessionID(session);

      if (!createdSessionID) {
        throw new Error('labeling_session_id_missing');
      }

      setOpenSessionID(createdSessionID);

      for (const capture of orderedCaptures) {
        await spotlightRepository.uploadLabelingSessionArtifact(makeUploadPayload(capture, createdSessionID));
      }

      const completed = await spotlightRepository.completeLabelingSession(createdSessionID, {
        completedAt: new Date().toISOString(),
      });

      capturePostHogEvent('labeling_session_completed');
      setCompletedSessionID(getLabelingSessionID(completed) ?? createdSessionID);
      setStep('done');
    } catch (error) {
      if (createdSessionID) {
        try {
          assertLabelingSessionRepository(spotlightRepository);
          await spotlightRepository.abortLabelingSession(createdSessionID, {
            abortedAt: new Date().toISOString(),
          });
        } catch {
          // Keep the visible failure on the submit error.
        }
      }

      setErrorMessage(errorMessageFromUnknown(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    hasAllCaptures,
    isSubmitting,
    orderedCaptures,
    selectedCard,
    spotlightRepository,
  ]);

  const renderHeader = (title: string, subtitle?: string) => (
    <View style={styles.header}>
      <ChromeBackButton onPress={handleBack} testID="labeler-back-button" />
      <View style={styles.headerCopy}>
        <Text style={[theme.typography.title, { color: theme.colors.textPrimary }]}>{title}</Text>
        {subtitle ? (
          <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>{subtitle}</Text>
        ) : null}
      </View>
    </View>
  );

  if (!hasLabelingAccess) {
    return (
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: theme.colors.pageLight }]}>
        {renderHeader('Label Session')}
        <StateCard
          actionLabel="Back"
          centered
          message="This account does not have labeler access."
          onActionPress={handleBack}
          style={styles.stateCard}
          title="Access needed"
        />
      </SafeAreaView>
    );
  }

  if (step === 'capture' && selectedCard) {
    return (
      <SafeAreaView edges={['left', 'right']} style={[styles.captureSafeArea, { backgroundColor: theme.colors.scannerCanvas }]}>
        <RawScannerCaptureSurface
          cameraRef={cameraRef}
          canCapture={canCapture}
          hasCameraPermission={permission?.granted ?? false}
          layout={captureSurfaceLayout}
          onCameraReady={() => {
            setIsCameraReady(true);
            resolveRawVisualPictureSize();
          }}
          onCapture={() => {
            void handleCapture();
          }}
          onRequestPermission={() => {
            void requestPermission();
          }}
          permissionCanAskAgain={permission?.canAskAgain}
          permissionResolved={!!permission}
          pictureSize={rawVisualPictureSize}
          prompt={`Tap inside frame to capture ${currentAngle.title}`}
          shouldMountCamera={permission?.granted ?? false}
          testIDPrefix="labeler"
        >
          <View
            style={[
              styles.captureBackButtonWrap,
              {
                left: 18,
                top: captureSurfaceLayout.backButtonTop,
              },
            ]}
          >
            <ChromeBackButton onPress={handleBack} testID="labeler-back-button" />
          </View>

          <View
            style={[
              styles.captureBottomPanelWrap,
              {
                paddingBottom: insets.bottom + 16,
                top: captureSurfaceLayout.controlsTop,
              },
            ]}
          >
            <View
              style={[
                styles.captureBottomPanel,
                {
                  backgroundColor: theme.colors.scannerTray,
                  borderColor: theme.colors.scannerOutlineSubtle,
                },
              ]}
            >
              <View style={styles.captureMetaCopy}>
                <Text numberOfLines={1} style={[theme.typography.headline, { color: theme.colors.scannerTextPrimary }]}>
                  {selectedCard.name}
                </Text>
                <Text numberOfLines={1} style={[theme.typography.caption, { color: theme.colors.scannerTextMuted }]}>
                  {selectedCard.setName} • {cardNumberLabel(selectedCard)}
                </Text>
                <Text style={[theme.typography.caption, { color: theme.colors.scannerTextSecondary }]}>
                  {currentAngleIndex + 1} of {requiredAngles.length}
                </Text>
              </View>

              <AngleProgress captures={captures} currentAngle={currentAngle.label} />

              {errorMessage ? (
                <Text style={[theme.typography.caption, styles.captureErrorText, { color: theme.colors.danger }]}>
                  {errorMessage}
                </Text>
              ) : null}

              <Button
                disabled={!canCapture}
                label={isCapturing ? 'Capturing' : `Capture ${currentAngle.title}`}
                onPress={() => {
                  void handleCapture();
                }}
                size="lg"
                testID="labeler-capture-button"
                variant="primary"
              />
            </View>
          </View>
        </RawScannerCaptureSurface>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.safeArea, { backgroundColor: theme.colors.pageLight }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {step === 'search' ? (
          <>
            {renderHeader('Label Session', 'Choose the exact card before capturing angles.')}

            <SearchField
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              containerStyle={{ backgroundColor: theme.colors.surface }}
              onChangeText={setQuery}
              placeholder="Search card, set, or number"
              returnKeyType="search"
              testID="labeler-search-input"
              value={query}
            />

            {isSearching ? (
              <SurfaceCard padding={theme.spacing.sm} radius={theme.radii.md} style={styles.searchState}>
                <ActivityIndicator color={theme.colors.brand} />
                <Text style={[theme.typography.body, { color: theme.colors.textSecondary }]}>
                  Searching catalog
                </Text>
              </SurfaceCard>
            ) : errorMessage ? (
              <StateCard
                centered
                message={errorMessage}
                style={styles.stateCard}
                title="Search unavailable"
              />
            ) : hasSearched && results.length === 0 ? (
              <StateCard
                centered
                message="Try a shorter query or a collector number."
                style={styles.stateCard}
                title="No matches"
              />
            ) : (
              <View style={styles.resultsList}>
                {results.map((result) => (
                  <SearchResultRow
                    key={result.id}
                    onPress={() => handleSelectResult(result)}
                    result={result}
                  />
                ))}
              </View>
            )}
          </>
        ) : null}

        {step === 'confirm' && selectedCard ? (
          <>
            {renderHeader('Confirm Card')}
            <CardSummary card={selectedCard} />
            <View style={styles.actionRow}>
              <Button
                label="Search again"
                onPress={() => setStep('search')}
                style={styles.actionButton}
                variant="secondary"
              />
              <Button
                label="Confirm card"
                onPress={handleConfirmCard}
                style={styles.actionButton}
                testID="labeler-confirm-card-button"
                variant="primary"
              />
            </View>
          </>
        ) : null}

        {step === 'review' && selectedCard ? (
          <>
            {renderHeader('Review Angles')}
            <CardSummary card={selectedCard} compact />
            <AngleProgress captures={captures} />

            <View style={styles.reviewList}>
              {requiredAngles.map((angle) => {
                const capture = captures[angle.label];

                return (
                  <SurfaceCard
                    key={angle.label}
                    padding={theme.spacing.sm}
                    radius={theme.radii.md}
                    style={styles.reviewRow}
                    testID={`labeler-review-${angle.label}`}
                    variant="elevated"
                  >
                    {capture ? (
                      <Image
                        resizeMode="cover"
                        source={{ uri: capture.thumbnailUri }}
                        style={[
                          styles.reviewThumb,
                          {
                            backgroundColor: theme.colors.field,
                          },
                        ]}
                      />
                    ) : (
                      <View style={[styles.reviewThumb, { backgroundColor: theme.colors.field }]} />
                    )}
                    <View style={styles.reviewCopy}>
                      <Text style={[theme.typography.headline, { color: theme.colors.textPrimary }]}>
                        {angle.title}
                      </Text>
                      <Text style={[theme.typography.caption, { color: theme.colors.textSecondary }]}>
                        {capture ? 'Captured' : 'Missing'}
                      </Text>
                    </View>
                    <Button
                      label="Retake"
                      onPress={() => handleRetake(angle.label)}
                      size="sm"
                      testID={`labeler-retake-${angle.label}`}
                      variant="secondary"
                    />
                  </SurfaceCard>
                );
              })}
            </View>

            {errorMessage ? (
              <Text style={[theme.typography.caption, styles.errorText, { color: theme.colors.danger }]}>
                {errorMessage}
              </Text>
            ) : null}

            <Button
              disabled={!hasAllCaptures || isSubmitting}
              label={isSubmitting ? 'Saving' : 'Done'}
              onPress={() => {
                void handleDone();
              }}
              size="lg"
              testID="labeler-done-button"
              variant="primary"
            />
          </>
        ) : null}

        {step === 'done' ? (
          <>
            {renderHeader('Session Saved')}
            <StateCard
              actionLabel="New session"
              actionTestID="labeler-new-session-button"
              centered
              message={completedSessionID ? `Saved ${requiredAngles.length} angles.` : 'Saved all angles.'}
              onActionPress={resetSession}
              style={styles.stateCard}
              title="Done"
              testID="labeler-done-state"
            />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionButton: {
    flex: 1,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
  },
  anglePill: {
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  angleProgress: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  cardArt: {
    height: '100%',
    width: '100%',
  },
  cardArtFallback: {
    paddingHorizontal: 8,
    textAlign: 'center',
  },
  cardArtFrame: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    height: 104,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 74,
  },
  cardSummary: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  cardSummaryCompact: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
  },
  cardSummaryCopy: {
    flex: 1,
    gap: 6,
    minWidth: 0,
  },
  content: {
    gap: 16,
    padding: 16,
    paddingBottom: 28,
  },
  captureBackButtonWrap: {
    position: 'absolute',
    zIndex: 5,
  },
  captureBottomPanel: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  captureBottomPanelWrap: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  captureErrorText: {
    textAlign: 'left',
  },
  captureMetaCopy: {
    gap: 4,
  },
  captureSafeArea: {
    flex: 1,
  },
  errorText: {
    textAlign: 'center',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  headerCopy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  resultCopy: {
    flex: 1,
    gap: 5,
    minWidth: 0,
  },
  resultImage: {
    borderRadius: 10,
    borderWidth: 1,
    height: 72,
    width: 52,
  },
  resultRow: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  resultsList: {
    gap: 10,
  },
  reviewCopy: {
    flex: 1,
    gap: 4,
    minWidth: 0,
  },
  reviewList: {
    gap: 10,
  },
  reviewRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  reviewThumb: {
    borderRadius: 10,
    height: 72,
    width: 52,
  },
  safeArea: {
    flex: 1,
  },
  searchState: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  stateCard: {
    marginTop: 8,
  },
});

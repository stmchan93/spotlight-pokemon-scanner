import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  LayoutAnimation,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

import type { CatalogSearchResult, InventoryCardEntry } from '@spotlight/api-client';
import {
  Button,
  colors,
  SegmentedControl,
  textStyles,
  useSpotlightTheme,
} from '@spotlight/design-system';

import { ChromeBackButton, chromeBackButtonSize } from '@/components/chrome-back-button';
import { useAppServices } from '@/providers/app-providers';

type ScannerMode = 'raw' | 'slabs';

type RecentCapture = {
  candidates: CatalogSearchResult[];
  id: string;
  isAddingToInventory: boolean;
  isLoadingCandidates: boolean;
  mode: ScannerMode;
  scanID: string | null;
  uri: string;
  activeCandidateIndex: number;
};

const scannerModes: readonly { label: string; value: ScannerMode }[] = [
  { label: 'RAW', value: 'raw' },
  { label: 'SLABS', value: 'slabs' },
];

const sharedFrameAspectRatio = 1.52;
const maxStoredCaptures = 12;
const collapsedVisibleCaptures = 1;
const captureRowHeight = 74;
const captureRowGap = 8;
const traySwipeThreshold = 36;
const trayVelocityThreshold = 0.48;
const trayExpandedLift = 56;
const trayCollapsedDrop = 40;

function alignToFourPointGrid(value: number) {
  return Math.max(0, Math.round(value / 4) * 4);
}

function makeReticleLayout({
  containerHeight,
  containerWidth,
  safeAreaTop,
  trayReservedHeight,
}: {
  containerHeight: number;
  containerWidth: number;
  safeAreaTop: number;
  trayReservedHeight: number;
}) {
  const horizontalInset = Math.max(16, Math.round(containerWidth * 0.04));
  const topSpacing = Math.max(safeAreaTop + 22, 74);
  const controlsTopSpacing = 12;
  const modeToggleReservedHeight = 64;
  const maxHeight = Math.max(
    360,
    containerHeight - topSpacing - controlsTopSpacing - modeToggleReservedHeight - trayReservedHeight,
  );
  const widthFromHeightLimit = Math.floor(maxHeight / sharedFrameAspectRatio);
  const width = Math.max(284, Math.min(containerWidth - horizontalInset * 2, widthFromHeightLimit));
  const height = Math.round(width * sharedFrameAspectRatio);

  return {
    controlsTopSpacing,
    height,
    topSpacing,
    width,
  };
}

function capturePrimaryLabel(mode: ScannerMode) {
  return mode === 'slabs' ? 'SLAB scan' : 'RAW scan';
}

function activeCandidateForCapture(capture: RecentCapture) {
  return capture.candidates[capture.activeCandidateIndex] ?? null;
}

function formatCurrency(amount: number, currencyCode = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function RefreshIcon({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <Svg fill="none" height={size} viewBox="0 0 18 18" width={size}>
      <Path
        d="M14.6 8.25A5.6 5.6 0 1 1 12.9 4.2"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
      <Path
        d="M11.95 2.9H14.9V5.85"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
      />
    </Svg>
  );
}

export function ScannerScreen() {
  const theme = useSpotlightTheme();
  const router = useRouter();
  const { dataVersion, refreshData, spotlightRepository } = useAppServices();
  const insets = useSafeAreaInsets();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const [scannerMode, setScannerMode] = useState<ScannerMode>('raw');
  const [permission, requestPermission] = useCameraPermissions();
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [inventoryEntries, setInventoryEntries] = useState<InventoryCardEntry[]>([]);
  const [recentCaptures, setRecentCaptures] = useState<RecentCapture[]>([]);
  const [isTrayExpanded, setIsTrayExpanded] = useState(false);
  const hasPromptedForPermissionRef = useRef(false);
  const cameraRef = useRef<CameraView | null>(null);
  const trayTranslateY = useRef(new Animated.Value(0)).current;

  const trayBottomInset = insets.bottom + 14;
  const collapsedTrayReservedHeight = 196;
  const reticleLayout = makeReticleLayout({
    containerHeight: windowHeight,
    containerWidth: windowWidth,
    safeAreaTop: insets.top,
    trayReservedHeight: collapsedTrayReservedHeight,
  });
  const reticleLeft = (windowWidth - reticleLayout.width) / 2;
  const reticleTop = reticleLayout.topSpacing + 16;
  const scannerBackTop = insets.top + 2;
  const promptTop = Math.max(insets.top + chromeBackButtonSize + 20, reticleTop - 36);
  const controlsTop = reticleTop + reticleLayout.height + reticleLayout.controlsTopSpacing;
  const modeToggleWidth = Math.min(windowWidth - 48, 264);
  const hasCameraAccess = permission?.granted ?? false;
  const canCapture = hasCameraAccess && isCameraReady && !isCapturing;
  const collapsedCaptures = recentCaptures.slice(0, collapsedVisibleCaptures);
  const visibleCaptures = isTrayExpanded ? recentCaptures : collapsedCaptures;
  const trayExpandedBodyHeight = alignToFourPointGrid(
    Math.min(Math.max((windowHeight - insets.top - insets.bottom) * 0.5, 272), 428),
  );
  const trayScrollViewportHeight = Math.max(140, trayExpandedBodyHeight);
  const trayContentHeight = recentCaptures.length === 0
    ? 0
    : (recentCaptures.length * captureRowHeight) + ((recentCaptures.length - 1) * captureRowGap);
  const trayScrollEnabled = trayContentHeight > trayScrollViewportHeight;
  const shouldLoadInventory = recentCaptures.length > 0 || dataVersion > 0;

  useEffect(() => {
    if (!shouldLoadInventory) {
      return undefined;
    }

    let isActive = true;

    const loadInventoryEntries = async () => {
      try {
        const nextEntries = await spotlightRepository.getInventoryEntries();
        if (isActive) {
          setInventoryEntries(nextEntries);
        }
      } catch {
        if (isActive) {
          setInventoryEntries([]);
        }
      }
    };

    void loadInventoryEntries();

    return () => {
      isActive = false;
    };
  }, [dataVersion, shouldLoadInventory, spotlightRepository]);

  useEffect(() => {
    if (!permission || permission.granted || !permission.canAskAgain || hasPromptedForPermissionRef.current) {
      return;
    }

    hasPromptedForPermissionRef.current = true;
    void requestPermission();
  }, [permission, requestPermission]);

  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  const animateTrayLayout = useCallback(() => {
    LayoutAnimation.configureNext({
      duration: 260,
      update: {
        type: LayoutAnimation.Types.easeInEaseOut,
      },
      create: {
        type: LayoutAnimation.Types.easeInEaseOut,
        property: LayoutAnimation.Properties.opacity,
      },
      delete: {
        type: LayoutAnimation.Types.easeInEaseOut,
        property: LayoutAnimation.Properties.opacity,
      },
    });
  }, []);

  const animateTraySettle = useCallback((velocity = 0) => {
    Animated.spring(trayTranslateY, {
      toValue: 0,
      useNativeDriver: true,
      damping: 24,
      stiffness: 260,
      mass: 0.9,
      velocity,
    }).start();
  }, [trayTranslateY]);

  const inventoryByCardId = useMemo(() => {
    const lookup = new Map<string, { entryIds: string[]; quantity: number }>();

    inventoryEntries.forEach((entry) => {
      const current = lookup.get(entry.cardId);
      if (current) {
        current.quantity += entry.quantity;
        current.entryIds.push(entry.id);
        return;
      }

      lookup.set(entry.cardId, {
        entryIds: [entry.id],
        quantity: entry.quantity,
      });
    });

    return lookup;
  }, [inventoryEntries]);

  const trayValue = useMemo(() => {
    return recentCaptures.reduce((sum, capture) => {
      return sum + (activeCandidateForCapture(capture)?.marketPrice ?? 0);
    }, 0);
  }, [recentCaptures]);

  const clearRecentCaptures = useCallback(() => {
    animateTrayLayout();
    setCaptureError(null);
    setRecentCaptures([]);
    setIsTrayExpanded(false);
    animateTraySettle();
  }, [animateTrayLayout, animateTraySettle]);

  const handleCapture = useCallback(async () => {
    if (!permission?.granted) {
      setCaptureError('Allow camera access to scan cards.');
      if (permission?.canAskAgain) {
        await requestPermission();
      }
      return;
    }

    if (!cameraRef.current || !isCameraReady || isCapturing) {
      return;
    }

    setIsCapturing(true);
    setCaptureError(null);

    const captureId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setRecentCaptures((current) => [
      {
        activeCandidateIndex: 0,
        candidates: [],
        id: captureId,
        isAddingToInventory: false,
        isLoadingCandidates: true,
        mode: scannerMode,
        scanID: null,
        uri: '',
      },
      ...current,
    ].slice(0, maxStoredCaptures));

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.7,
      });

      setIsCapturing(false);

      if (!photo?.uri || !photo.base64) {
        setCaptureError('Camera capture finished without an image.');
        setRecentCaptures((current) => current.map((capture) => {
          if (capture.id !== captureId) {
            return capture;
          }

          return {
            ...capture,
            isLoadingCandidates: false,
            uri: photo?.uri ?? '',
          };
        }));
        return;
      }

      const photoBase64 = photo.base64;
      setRecentCaptures((current) => current.map((capture) => {
        if (capture.id !== captureId) {
          return capture;
        }

        return {
          ...capture,
          uri: photo.uri,
        };
      }));

      void (async () => {
        try {
          const matchResult = await spotlightRepository.matchScannerCapture({
            height: photo.height ?? 1,
            jpegBase64: photoBase64,
            mode: scannerMode,
            width: photo.width ?? 1,
          });
          setRecentCaptures((current) => current.map((capture) => {
            if (capture.id !== captureId) {
              return capture;
            }

            return {
              ...capture,
              activeCandidateIndex: 0,
              candidates: matchResult.candidates,
              isLoadingCandidates: false,
              scanID: matchResult.scanID,
            };
          }));
        } catch {
          setRecentCaptures((current) => current.map((capture) => {
            if (capture.id !== captureId) {
              return capture;
            }

            return {
              ...capture,
              candidates: [],
              isLoadingCandidates: false,
              scanID: null,
            };
          }));
        }
      })();
    } catch {
      setCaptureError('Could not capture photo right now.');
      setIsCapturing(false);
    }
  }, [isCameraReady, isCapturing, permission, requestPermission, scannerMode, spotlightRepository]);

  const cycleCandidate = useCallback((captureId: string) => {
    setRecentCaptures((current) => current.map((capture) => {
      if (capture.id !== captureId || capture.candidates.length <= 1) {
        return capture;
      }

      return {
        ...capture,
        activeCandidateIndex: (capture.activeCandidateIndex + 1) % capture.candidates.length,
      };
    }));
  }, []);

  const handleAddToInventory = useCallback(async (captureId: string) => {
    const capture = recentCaptures.find((candidate) => candidate.id === captureId);
    const activeCandidate = capture ? activeCandidateForCapture(capture) : null;
    if (!capture || !activeCandidate || capture.isLoadingCandidates || capture.isAddingToInventory) {
      return;
    }

    setRecentCaptures((current) => current.map((entry) => {
      if (entry.id !== captureId) {
        return entry;
      }

      return {
        ...entry,
        isAddingToInventory: true,
      };
    }));

    try {
      await spotlightRepository.createPortfolioBuy({
        boughtAt: new Date().toISOString(),
        cardID: activeCandidate.cardId,
        condition: 'near_mint',
        currencyCode: activeCandidate.currencyCode ?? 'USD',
        paymentMethod: null,
        quantity: 1,
        slabContext: null,
        sourceScanID: capture.scanID ?? captureId,
        unitPrice: activeCandidate.marketPrice ?? 0,
        variantName: null,
      });
      const nextEntries = await spotlightRepository.getInventoryEntries();
      setInventoryEntries(nextEntries);
      refreshData();
    } catch {
      setCaptureError('Could not add that card to inventory right now.');
    } finally {
      setRecentCaptures((current) => current.map((entry) => {
        if (entry.id !== captureId) {
          return entry;
        }

        return {
          ...entry,
          isAddingToInventory: false,
        };
      }));
    }
  }, [recentCaptures, refreshData, spotlightRepository]);

  const handleOpenCard = useCallback(async (captureId: string) => {
    const capture = recentCaptures.find((entry) => entry.id === captureId);
    const candidate = capture ? activeCandidateForCapture(capture) : null;
    if (!candidate || capture?.isLoadingCandidates) {
      return;
    }

    const matchingInventoryEntries = inventoryByCardId.get(candidate.cardId)?.entryIds ?? [];
    router.push({
      pathname: '/cards/[cardId]',
      params: {
        cardId: candidate.cardId,
        entryId: matchingInventoryEntries[0],
      },
    });
  }, [inventoryByCardId, recentCaptures, router]);

  const toggleTrayExpanded = useCallback(() => {
    if (recentCaptures.length <= 1) {
      return;
    }

    animateTrayLayout();
    setIsTrayExpanded((current) => !current);
    animateTraySettle();
  }, [animateTrayLayout, animateTraySettle, recentCaptures.length]);

  const handleExitScanner = useCallback(() => {
    router.replace('/portfolio');
  }, [router]);

  const trayHeaderPanResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gestureState) =>
      Math.abs(gestureState.dy) > 8 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
    onPanResponderMove: (_, gestureState) => {
      const proposedOffset = gestureState.dy;
      if (isTrayExpanded) {
        trayTranslateY.setValue(Math.max(-18, Math.min(trayCollapsedDrop, proposedOffset)));
        return;
      }

      trayTranslateY.setValue(Math.min(18, Math.max(-trayExpandedLift, proposedOffset)));
    },
    onPanResponderRelease: (_, gestureState) => {
      const shouldExpand = recentCaptures.length > 1
        && !isTrayExpanded
        && (gestureState.dy <= -traySwipeThreshold || gestureState.vy <= -trayVelocityThreshold);
      const shouldCollapse = isTrayExpanded
        && (gestureState.dy >= traySwipeThreshold || gestureState.vy >= trayVelocityThreshold);

      if (shouldExpand) {
        animateTrayLayout();
        setIsTrayExpanded(true);
      } else if (shouldCollapse) {
        animateTrayLayout();
        setIsTrayExpanded(false);
      }

      animateTraySettle(gestureState.vy);
    },
    onPanResponderTerminate: () => {
      animateTraySettle();
    },
  }), [animateTrayLayout, animateTraySettle, isTrayExpanded, recentCaptures.length, trayTranslateY]);

  const promptCopy = !permission
    ? 'Starting camera...'
    : !permission.granted
      ? 'Allow camera access to scan'
      : isCapturing
        ? 'Capturing scan...'
        : 'Tap anywhere to scan';

  const renderCaptureRow = (capture: RecentCapture, index: number) => {
    const candidate = activeCandidateForCapture(capture);
    const inventoryMatch = candidate ? inventoryByCardId.get(candidate.cardId) : null;
    const quantity = inventoryMatch?.quantity ?? 0;
    const marketPrice = candidate?.marketPrice ?? 0;
    const currencyCode = candidate?.currencyCode ?? 'USD';

    return (
      <View key={capture.id} style={styles.captureRow} testID={`scanner-tray-row-${index}`}>
        <Pressable
          accessibilityLabel={candidate ? `Open ${candidate.name}` : `Open recent scan ${index + 1}`}
          accessibilityRole="button"
          onPress={() => {
            void handleOpenCard(capture.id);
          }}
          style={({ pressed }) => [
            styles.captureMainButton,
            pressed ? styles.captureMainButtonPressed : null,
          ]}
          testID={`scanner-tray-open-card-${index}`}
        >
          <View style={styles.captureThumbWrap}>
            {candidate?.imageUrl || capture.uri ? (
              <Image
                source={{ uri: candidate?.imageUrl || capture.uri }}
                style={styles.captureThumb}
                testID={`scanner-tray-image-${index}`}
              />
            ) : (
              <View style={styles.captureThumb} testID={`scanner-tray-image-${index}`} />
            )}
            {candidate && capture.candidates.length > 1 ? (
              <Pressable
                accessibilityLabel="Refresh match"
                onPress={(event) => {
                  event?.stopPropagation?.();
                  cycleCandidate(capture.id);
                }}
                style={styles.captureRefreshButton}
                testID={`scanner-tray-refresh-${index}`}
                hitSlop={8}
              >
                {({ pressed }) => (
                  <View style={pressed ? styles.captureRefreshPressed : null}>
                    <RefreshIcon color={colors.scannerTextPrimary} size={14} />
                  </View>
                )}
              </Pressable>
            ) : null}
          </View>

          <View style={styles.captureCopy}>
            {capture.isLoadingCandidates ? (
              <>
                <View style={styles.captureLoadingRow}>
                  <ActivityIndicator color={theme.colors.brand} size="small" />
                  <Text style={styles.captureTitle}>Finding match</Text>
                </View>
                <Text style={styles.captureSubtitle}>Photo captured and queued for scan review</Text>
              </>
            ) : candidate ? (
              <>
                <Text numberOfLines={1} style={styles.captureTitle}>{candidate.name}</Text>
                <Text numberOfLines={1} style={styles.captureSubtitle}>
                  {candidate.setName}
                  {' • '}
                  {candidate.cardNumber}
                </Text>
              </>
            ) : (
              <>
                <Text numberOfLines={1} style={styles.captureTitle}>{capturePrimaryLabel(capture.mode)}</Text>
                <Text numberOfLines={2} style={styles.captureSubtitle}>Photo captured, but matches could not load</Text>
              </>
            )}
          </View>

          {candidate ? (
            <View style={styles.capturePriceWrap}>
              <Text style={styles.capturePriceLabel}>MARKET</Text>
              <Text style={styles.capturePriceValue}>{formatCurrency(marketPrice, currencyCode)}</Text>
              {quantity > 0 ? (
                <View style={styles.captureQuantityPill}>
                  <Text style={styles.captureQuantityText} testID={`scanner-tray-qty-${index}`}>QTY {quantity}</Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </Pressable>

        {candidate ? (
          <View style={styles.captureActionWrap}>
            <Pressable
              accessibilityLabel={`Add ${candidate.name} to inventory`}
              accessibilityRole="button"
              disabled={capture.isAddingToInventory}
              onPress={() => {
                void handleAddToInventory(capture.id);
              }}
              style={({ pressed }) => [
                styles.captureAddButton,
                pressed ? styles.captureAddButtonPressed : null,
                capture.isAddingToInventory ? styles.captureAddButtonDisabled : null,
              ]}
              testID={`scanner-tray-add-${index}`}
            >
              {capture.isAddingToInventory ? (
                <ActivityIndicator color={colors.scannerCanvas} size="small" />
              ) : (
                <Text style={styles.captureAddIcon}>+</Text>
              )}
            </Pressable>
            <Text style={styles.captureAddLabel}>ADD</Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <SafeAreaView edges={['left', 'right']} style={styles.safeArea}>
      <View style={styles.previewCanvas}>
        {hasCameraAccess ? (
          <CameraView
            facing="back"
            onCameraReady={() => {
              setIsCameraReady(true);
              setCaptureError(null);
            }}
            ref={cameraRef}
            style={StyleSheet.absoluteFillObject}
            testID="scanner-camera"
          />
        ) : (
          <View style={[StyleSheet.absoluteFillObject, styles.cameraFallback]} testID="scanner-camera-fallback" />
        )}

        {hasCameraAccess ? (
          <Pressable
            accessibilityLabel="Capture scan"
            accessibilityRole="button"
            disabled={!canCapture}
            onPress={() => {
              void handleCapture();
            }}
            style={StyleSheet.absoluteFillObject}
            testID="scanner-preview"
          />
        ) : null}

        {!hasCameraAccess ? (
          <View style={styles.permissionOverlay}>
            <View style={styles.permissionCard} testID="scanner-permission-card">
              {!permission ? (
                <ActivityIndicator color={theme.colors.scannerTextPrimary} />
              ) : null}
              <Text style={styles.permissionHeadline}>Camera access needed</Text>
              <Text style={styles.permissionBody}>
                Spotlight needs a real camera preview here so tap-to-scan can capture a photo.
              </Text>
              <Button
                label={permission?.canAskAgain === false ? 'Open Settings and enable camera' : 'Enable camera'}
                onPress={() => {
                  void requestPermission();
                }}
                style={styles.permissionButton}
                testID="scanner-enable-camera"
                variant="primary"
              />
            </View>
          </View>
        ) : null}

        <View
          style={[
            styles.backButtonWrap,
            {
              left: 18,
              top: scannerBackTop,
            },
          ]}
        >
          <ChromeBackButton
            accessibilityLabel="Exit scanner"
            onPress={handleExitScanner}
            testID="scanner-back-button"
          />
        </View>

        <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
          <Text style={[styles.scanPrompt, { top: promptTop }]} testID="scanner-prompt">
            {promptCopy}
          </Text>

          {captureError ? (
            <View style={[styles.captureErrorPill, { top: promptTop + 32 }]}>
              <Text style={styles.captureErrorText}>{captureError}</Text>
            </View>
          ) : null}

          <View
            style={[
              styles.reticleShell,
              {
                height: reticleLayout.height,
                left: reticleLeft,
                top: reticleTop,
                width: reticleLayout.width,
              },
            ]}
            testID="scanner-reticle"
          >
            {scannerMode === 'slabs' ? (
              <View
                style={[
                  styles.slabGuide,
                  {
                    top: reticleLayout.height * 0.28,
                  },
                ]}
                testID="scanner-slab-guide"
              />
            ) : null}

            <View style={[styles.reticleCorner, styles.reticleTopLeft, styles.reticleTopLeftPosition]} />
            <View style={[styles.reticleCorner, styles.reticleTopRight, styles.reticleTopRightPosition]} />
            <View style={[styles.reticleCorner, styles.reticleBottomLeft, styles.reticleBottomLeftPosition]} />
            <View style={[styles.reticleCorner, styles.reticleBottomRight, styles.reticleBottomRightPosition]} />
          </View>
        </View>

        <View
          style={[
            styles.modeToggleWrap,
            {
              top: controlsTop,
            },
          ]}
        >
          <View style={{ width: modeToggleWidth }}>
            <SegmentedControl
              items={scannerModes}
              onChange={setScannerMode}
              size="scanner"
              testID="scanner-mode-toggle"
              tone="inverted"
              value={scannerMode}
            />
          </View>
        </View>

        <Animated.View
          style={[
            styles.trayShell,
            {
              transform: [{ translateY: trayTranslateY }],
            },
          ]}
          testID="scanner-tray"
        >
          <View
            style={styles.trayHeader}
            testID="scanner-tray-header"
            {...trayHeaderPanResponder.panHandlers}
          >
            {recentCaptures.length > 1 ? (
              <Pressable
                accessibilityLabel={isTrayExpanded ? 'Collapse recent scans' : 'Expand recent scans'}
                accessibilityRole="button"
                onPress={toggleTrayExpanded}
                style={styles.sheetHandleButton}
                testID="scanner-tray-toggle"
              >
                <View style={styles.sheetHandle} />
              </Pressable>
            ) : (
              <View style={styles.sheetHandleButton}>
                <View style={styles.sheetHandle} />
              </View>
            )}

            <View style={styles.recentScansRow}>
              <View style={styles.recentScansMetaRow}>
                <Text style={styles.recentScansTitle} testID="scanner-recent-title">Recent scans</Text>
                {recentCaptures.length > 0 ? (
                  <Pressable
                    accessibilityLabel="Clear recent scans"
                    accessibilityRole="button"
                    onPress={clearRecentCaptures}
                    style={({ pressed }) => [
                      styles.clearPill,
                      pressed ? styles.clearPillPressed : null,
                    ]}
                    testID="scanner-clear-button"
                  >
                    <Text style={styles.clearPillText}>CLEAR</Text>
                  </Pressable>
                ) : null}
              </View>

              <View style={styles.recentScansActions}>
                <View style={styles.valuePill}>
                  <Text style={styles.valuePillText} testID="scanner-value-pill-text">
                    {formatCurrency(trayValue)}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          <View
            style={[
              styles.trayBody,
              {
                paddingBottom: trayBottomInset,
              },
              isTrayExpanded ? styles.trayBodyExpanded : null,
            ]}
            testID="scanner-tray-body"
          >
            {recentCaptures.length === 0 ? (
              <View style={styles.trayEmptyFill} />
            ) : isTrayExpanded ? (
              <View
                style={[
                  styles.trayViewport,
                  {
                    height: trayScrollViewportHeight,
                  },
                ]}
                testID="scanner-tray-viewport"
              >
                <ScrollView
                  nestedScrollEnabled
                  scrollEnabled={trayScrollEnabled}
                  showsVerticalScrollIndicator={trayScrollEnabled}
                  style={styles.trayScroll}
                  contentContainerStyle={styles.trayScrollContent}
                  testID="scanner-tray-scroll"
                >
                  {visibleCaptures.map(renderCaptureRow)}
                </ScrollView>
              </View>
            ) : (
              visibleCaptures.map(renderCaptureRow)
            )}
          </View>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  backButtonWrap: {
    position: 'absolute',
    zIndex: 5,
  },
  cameraFallback: {
    backgroundColor: colors.scannerCanvas,
  },
  captureActionWrap: {
    alignItems: 'center',
    gap: 4,
    justifyContent: 'center',
    width: 56,
  },
  captureAddButton: {
    alignItems: 'center',
    backgroundColor: colors.brand,
    borderRadius: 10,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  captureAddButtonDisabled: {
    opacity: 0.52,
  },
  captureAddButtonPressed: {
    opacity: 0.86,
  },
  captureAddIcon: {
    color: colors.scannerCanvas,
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 30,
    marginTop: -2,
    textAlign: 'center',
  },
  captureAddLabel: {
    ...textStyles.control,
    color: colors.brand,
    fontSize: 12,
    lineHeight: 14,
  },
  captureCopy: {
    flex: 1,
    gap: 4,
  },
  captureErrorPill: {
    alignSelf: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.52)',
    borderColor: colors.scannerOutline,
    borderRadius: 999,
    borderWidth: 1,
    maxWidth: 260,
    paddingHorizontal: 14,
    paddingVertical: 8,
    position: 'absolute',
  },
  captureErrorText: {
    ...textStyles.caption,
    color: colors.scannerTextPrimary,
    textAlign: 'center',
  },
  captureLoadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  captureMeta: {
    ...textStyles.caption,
    color: colors.scannerTextMuted,
  },
  captureMainButton: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 12,
  },
  captureMainButtonPressed: {
    opacity: 0.9,
  },
  capturePriceLabel: {
    ...textStyles.caption,
    color: colors.scannerTextMeta,
    letterSpacing: 0.7,
  },
  capturePriceValue: {
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
    textAlign: 'right',
  },
  capturePriceWrap: {
    alignItems: 'flex-end',
    gap: 4,
    justifyContent: 'center',
    minWidth: 96,
  },
  captureQuantityPill: {
    alignItems: 'center',
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 34,
    minWidth: 74,
    paddingHorizontal: 14,
  },
  captureQuantitySpacer: {
    height: 34,
  },
  captureQuantityText: {
    ...textStyles.control,
    color: colors.scannerTextPrimary,
    fontSize: 12,
    lineHeight: 14,
  },
  captureRow: {
    alignItems: 'center',
    backgroundColor: colors.scannerSurfaceMuted,
    borderColor: colors.scannerOutlineSubtle,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: captureRowHeight,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  captureRefreshButton: {
    alignItems: 'center',
    bottom: 2,
    height: 14,
    justifyContent: 'center',
    left: 2,
    position: 'absolute',
    width: 14,
  },
  captureRefreshPressed: {
    opacity: 0.76,
  },
  captureSubtitle: {
    ...textStyles.caption,
    color: colors.scannerTextMuted,
  },
  captureThumb: {
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 14,
    height: 54,
    width: 44,
  },
  captureThumbWrap: {
    height: 54,
    position: 'relative',
    width: 44,
  },
  captureTitle: {
    ...textStyles.bodyStrong,
    color: colors.scannerTextPrimary,
  },
  clearPill: {
    alignItems: 'center',
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 28,
    paddingHorizontal: 14,
  },
  clearPillPressed: {
    opacity: 0.82,
  },
  clearPillText: {
    ...textStyles.control,
    color: colors.scannerTextMeta,
    fontSize: 12,
    lineHeight: 14,
  },
  modeToggleWrap: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  permissionBody: {
    ...textStyles.body,
    color: colors.scannerTextSecondary,
    textAlign: 'center',
  },
  permissionButton: {
    marginTop: 6,
    minWidth: 220,
    width: '100%',
  },
  permissionCard: {
    alignItems: 'center',
    backgroundColor: 'rgba(8, 8, 10, 0.9)',
    borderColor: colors.scannerOutline,
    borderRadius: 28,
    borderWidth: 1,
    gap: 10,
    maxWidth: 300,
    paddingHorizontal: 24,
    paddingVertical: 24,
  },
  permissionHeadline: {
    ...textStyles.titleCompact,
    color: colors.scannerTextPrimary,
    textAlign: 'center',
  },
  permissionOverlay: {
    alignItems: 'center',
    justifyContent: 'center',
    ...StyleSheet.absoluteFillObject,
    paddingHorizontal: 28,
  },
  previewCanvas: {
    flex: 1,
    overflow: 'hidden',
  },
  recentScansActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'flex-end',
  },
  recentScansMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 8,
  },
  recentScansRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  recentScansTitle: {
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
  },
  reticleBottomLeft: {
    borderBottomWidth: 1.7,
    borderLeftWidth: 1.7,
  },
  reticleBottomLeftPosition: {
    bottom: 2,
    left: 2,
  },
  reticleBottomRight: {
    borderBottomWidth: 1.7,
    borderRightWidth: 1.7,
  },
  reticleBottomRightPosition: {
    bottom: 2,
    right: 2,
  },
  reticleCorner: {
    borderColor: colors.scannerTextPrimary,
    height: 30,
    position: 'absolute',
    width: 30,
  },
  reticleShell: {
    borderColor: colors.scannerOutline,
    borderRadius: 20,
    borderWidth: 1,
    position: 'absolute',
  },
  reticleTopLeft: {
    borderLeftWidth: 1.7,
    borderTopWidth: 1.7,
  },
  reticleTopLeftPosition: {
    left: 2,
    top: 2,
  },
  reticleTopRight: {
    borderRightWidth: 1.7,
    borderTopWidth: 1.7,
  },
  reticleTopRightPosition: {
    right: 2,
    top: 2,
  },
  safeArea: {
    backgroundColor: colors.scannerCanvas,
    flex: 1,
  },
  scanPrompt: {
    alignSelf: 'center',
    ...textStyles.headline,
    color: colors.scannerTextPrimary,
    position: 'absolute',
    textShadowColor: 'rgba(0, 0, 0, 0.32)',
    textShadowOffset: {
      width: 0,
      height: 2,
    },
    textShadowRadius: 8,
    top: 0,
  },
  matchesButton: {
    minWidth: 116,
  },
  matchesPanel: {
    backgroundColor: colors.scannerSurfaceMuted,
    borderColor: colors.scannerOutlineSubtle,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 12,
  },
  matchesPanelList: {
    gap: 8,
  },
  matchesPanelTitle: {
    ...textStyles.control,
    color: colors.scannerTextPrimary,
  },
  matchOptionCopy: {
    flex: 1,
    gap: 2,
  },
  matchOptionMeta: {
    ...textStyles.caption,
    color: colors.scannerTextMuted,
  },
  matchOptionPrice: {
    ...textStyles.bodyStrong,
    color: colors.scannerTextPrimary,
  },
  matchOptionRow: {
    alignItems: 'center',
    backgroundColor: colors.scannerSurfaceStrong,
    borderRadius: 14,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  matchOptionRowPressed: {
    opacity: 0.86,
  },
  matchOptionThumb: {
    backgroundColor: colors.scannerSurface,
    borderRadius: 10,
    height: 52,
    width: 40,
  },
  matchOptionTitle: {
    ...textStyles.bodyStrong,
    color: colors.scannerTextPrimary,
  },
  sheetHandle: {
    alignSelf: 'center',
    backgroundColor: colors.scannerTextMeta,
    borderRadius: 999,
    height: 5,
    width: 54,
  },
  sheetHandleButton: {
    alignItems: 'center',
    paddingBottom: 6,
    paddingTop: 6,
  },
  slabGuide: {
    backgroundColor: colors.scannerTextPrimary,
    height: 1,
    left: 20,
    position: 'absolute',
    right: 20,
  },
  trayBody: {
    gap: 12,
    minHeight: 104,
    paddingHorizontal: 4,
    paddingTop: 0,
  },
  trayBodyExpanded: {
    minHeight: 0,
  },
  trayEmptyFill: {
    flex: 1,
    minHeight: 32,
  },
  trayHeader: {
    backgroundColor: colors.scannerTray,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  trayScroll: {
    width: '100%',
  },
  trayScrollContent: {
    gap: captureRowGap,
  },
  trayViewport: {
    width: '100%',
  },
  trayShell: {
    backgroundColor: colors.scannerTray,
    borderColor: colors.scannerOutlineSubtle,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    shadowColor: '#000000',
    shadowOffset: {
      height: -12,
      width: 0,
    },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 12,
  },
  valuePill: {
    backgroundColor: colors.scannerValuePill,
    borderColor: colors.scannerOutline,
    borderRadius: 999,
    borderWidth: 1,
    minHeight: 28,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  valuePillText: {
    ...textStyles.bodyStrong,
    color: colors.scannerTextPrimary,
  },
});

import { CameraView } from 'expo-camera';
import type { ReactNode, RefObject } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  Button,
  colors,
  textStyles,
} from '@spotlight/design-system';

import { chromeBackButtonSize } from '@/components/chrome-back-button';
import { rawCardReticleAspectRatio } from '@/features/scanner/scanner-normalized-target';

export const rawVisualCaptureQuality = 0.62;
export const rawVisualPreferredLongSide = 1280;
export const rawVisualMinimumLongSide = 900;
export const rawScannerTrayReservedHeight = 168;

export type RawScannerCaptureLayout = {
  backButtonTop: number;
  controlsTop: number;
  modeToggleWidth: number;
  previewHeight: number;
  previewWidth: number;
  promptTop: number;
  reticle: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
};

type RawScannerCaptureSurfaceProps = {
  availableLensesChanged?: (event: { lenses: string[] }) => void;
  cameraRef: RefObject<CameraView | null>;
  cameraSessionKey?: number;
  canCapture: boolean;
  children?: ReactNode;
  hasCameraPermission: boolean;
  layout: RawScannerCaptureLayout;
  onCameraReady: () => void;
  onCapture: () => void;
  onRequestPermission: () => void;
  permissionCanAskAgain?: boolean;
  permissionResolved: boolean;
  pictureSize?: string;
  prompt: string;
  selectedLens?: string;
  shouldMountCamera: boolean;
  showSlabGuide?: boolean;
  testIDPrefix: string;
};

function parsePictureSize(size: string) {
  const match = size.trim().match(/^(\d+)x(\d+)$/);
  if (!match) {
    return null;
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    area: width * height,
    longSide: Math.max(width, height),
    raw: size,
  };
}

export function chooseRawVisualPictureSize(sizes: readonly string[]) {
  const parsed = sizes
    .map(parsePictureSize)
    .filter((size): size is NonNullable<ReturnType<typeof parsePictureSize>> => size != null);
  if (parsed.length === 0) {
    return null;
  }

  const preferred = parsed
    .filter((size) => size.longSide >= rawVisualMinimumLongSide && size.longSide <= rawVisualPreferredLongSide)
    .sort((a, b) => a.area - b.area);
  if (preferred[0]) {
    return preferred[0].raw;
  }

  const largerFallback = parsed
    .filter((size) => size.longSide > rawVisualPreferredLongSide)
    .sort((a, b) => a.area - b.area);
  if (largerFallback[0]) {
    return largerFallback[0].raw;
  }

  return parsed.sort((a, b) => b.area - a.area)[0]?.raw ?? null;
}

export function makeRawScannerCaptureLayout({
  containerHeight,
  containerWidth,
  safeAreaTop,
  trayReservedHeight = rawScannerTrayReservedHeight,
}: {
  containerHeight: number;
  containerWidth: number;
  safeAreaTop: number;
  trayReservedHeight?: number;
}): RawScannerCaptureLayout {
  const horizontalInset = 20;
  const topChromeBottom = safeAreaTop + chromeBackButtonSize + 16;
  const topSpacing = topChromeBottom + 4;
  const controlsTopSpacing = 10;
  const modeToggleReservedHeight = 56;
  const maxHeight = Math.max(
    360,
    containerHeight - topSpacing - controlsTopSpacing - modeToggleReservedHeight - trayReservedHeight,
  );
  const widthFromHeightLimit = Math.floor(maxHeight / rawCardReticleAspectRatio);
  const width = Math.max(284, Math.min(containerWidth - horizontalInset * 2, widthFromHeightLimit));
  const height = Math.round(width * rawCardReticleAspectRatio);
  const x = (containerWidth - width) / 2;
  const y = topSpacing + 24;

  return {
    backButtonTop: safeAreaTop + 10,
    controlsTop: y + height + controlsTopSpacing,
    modeToggleWidth: Math.min(containerWidth - 48, 264),
    previewHeight: containerHeight,
    previewWidth: containerWidth,
    promptTop: Math.max(topChromeBottom + 8, y + 12),
    reticle: {
      height,
      width,
      x,
      y,
    },
  };
}

export function RawScannerCaptureSurface({
  availableLensesChanged,
  cameraRef,
  cameraSessionKey = 0,
  canCapture,
  children,
  hasCameraPermission,
  layout,
  onCameraReady,
  onCapture,
  onRequestPermission,
  permissionCanAskAgain,
  permissionResolved,
  pictureSize,
  prompt,
  selectedLens,
  shouldMountCamera,
  showSlabGuide = false,
  testIDPrefix,
}: RawScannerCaptureSurfaceProps) {
  return (
    <View style={styles.previewCanvas}>
      {shouldMountCamera ? (
        <CameraView
          autofocus="off"
          facing="back"
          key={cameraSessionKey}
          onAvailableLensesChanged={availableLensesChanged}
          onCameraReady={onCameraReady}
          pictureSize={Platform.OS === 'android' ? pictureSize : undefined}
          ref={cameraRef}
          selectedLens={Platform.OS === 'ios' ? selectedLens : undefined}
          style={StyleSheet.absoluteFillObject}
          testID={`${testIDPrefix}-camera`}
        />
      ) : (
        <View
          style={[StyleSheet.absoluteFillObject, styles.cameraFallback]}
          testID={`${testIDPrefix}-camera-fallback`}
        />
      )}

      {shouldMountCamera ? (
        <Pressable
          accessibilityLabel="Capture scan inside frame"
          accessibilityRole="button"
          disabled={!canCapture}
          onPress={onCapture}
          style={[
            styles.reticleCaptureButton,
            {
              height: layout.reticle.height,
              left: layout.reticle.x,
              top: layout.reticle.y,
              width: layout.reticle.width,
            },
          ]}
          testID={`${testIDPrefix}-preview`}
        />
      ) : null}

      {!hasCameraPermission ? (
        <View style={styles.permissionOverlay}>
          <View style={styles.permissionCard} testID={`${testIDPrefix}-permission-card`}>
            {!permissionResolved ? (
              <ActivityIndicator color={colors.scannerTextPrimary} />
            ) : null}
            <Text style={styles.permissionHeadline}>Camera access needed</Text>
            <Text style={styles.permissionBody}>
              Spotlight needs a real camera preview here so tap-to-scan can capture a photo.
            </Text>
            <Button
              label={permissionCanAskAgain === false ? 'Open Settings and enable camera' : 'Enable camera'}
              onPress={onRequestPermission}
              style={styles.permissionButton}
              testID={`${testIDPrefix}-enable-camera`}
              variant="primary"
            />
          </View>
        </View>
      ) : null}

      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        <Text style={[styles.scanPrompt, { top: layout.promptTop }]} testID={`${testIDPrefix}-prompt`}>
          {prompt}
        </Text>

        <View
          style={[
            styles.reticleShell,
            {
              height: layout.reticle.height,
              left: layout.reticle.x,
              top: layout.reticle.y,
              width: layout.reticle.width,
            },
          ]}
          testID={`${testIDPrefix}-reticle`}
        >
          {showSlabGuide ? (
            <View
              style={[
                styles.slabGuide,
                {
                  top: layout.reticle.height * 0.28,
                },
              ]}
              testID={`${testIDPrefix}-slab-guide`}
            />
          ) : null}

          <View style={[styles.reticleCorner, styles.reticleTopLeft, styles.reticleTopLeftPosition]} />
          <View style={[styles.reticleCorner, styles.reticleTopRight, styles.reticleTopRightPosition]} />
          <View style={[styles.reticleCorner, styles.reticleBottomLeft, styles.reticleBottomLeftPosition]} />
          <View style={[styles.reticleCorner, styles.reticleBottomRight, styles.reticleBottomRightPosition]} />
        </View>
      </View>

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  cameraFallback: {
    backgroundColor: colors.scannerCanvas,
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
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  previewCanvas: {
    flex: 1,
    overflow: 'hidden',
  },
  reticleBottomLeft: {
    borderBottomLeftRadius: 14,
    borderBottomWidth: 1.7,
    borderLeftWidth: 1.7,
  },
  reticleBottomLeftPosition: {
    bottom: 0,
    left: 0,
  },
  reticleBottomRight: {
    borderBottomRightRadius: 14,
    borderBottomWidth: 1.7,
    borderRightWidth: 1.7,
  },
  reticleBottomRightPosition: {
    bottom: 0,
    right: 0,
  },
  reticleCaptureButton: {
    position: 'absolute',
  },
  reticleCorner: {
    borderColor: colors.scannerTextPrimary,
    height: 20,
    position: 'absolute',
    width: 20,
  },
  reticleShell: {
    borderColor: colors.scannerOutline,
    borderRadius: 14,
    borderWidth: 1,
    position: 'absolute',
  },
  reticleTopLeft: {
    borderLeftWidth: 1.7,
    borderTopLeftRadius: 14,
    borderTopWidth: 1.7,
  },
  reticleTopLeftPosition: {
    left: 0,
    top: 0,
  },
  reticleTopRight: {
    borderRightWidth: 1.7,
    borderTopRightRadius: 14,
    borderTopWidth: 1.7,
  },
  reticleTopRightPosition: {
    right: 0,
    top: 0,
  },
  scanPrompt: {
    ...textStyles.headline,
    alignSelf: 'center',
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
  slabGuide: {
    backgroundColor: colors.scannerTextPrimary,
    height: 1,
    left: 0,
    opacity: 0.22,
    position: 'absolute',
    right: 0,
  },
});

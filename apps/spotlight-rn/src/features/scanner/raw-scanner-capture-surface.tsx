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

export const rawVisualCaptureQuality = 0.45;
export const rawVisualPreferredLongSide = 1280;
export const rawVisualMinimumLongSide = 900;
export const rawScannerTrayReservedHeight = 196;

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
  cameraRef: RefObject<CameraView | null>;
  cameraSessionKey?: number;
  canCapture: boolean;
  children?: ReactNode;
  hasCameraAccess: boolean;
  layout: RawScannerCaptureLayout;
  onCameraReady: () => void;
  onCapture: () => void;
  onRequestPermission: () => void;
  permissionCanAskAgain?: boolean;
  permissionResolved: boolean;
  pictureSize?: string;
  prompt: string;
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
  const horizontalInset = Math.max(16, Math.round(containerWidth * 0.04));
  const topSpacing = Math.max(safeAreaTop + 22, 74);
  const controlsTopSpacing = 12;
  const modeToggleReservedHeight = 64;
  const maxHeight = Math.max(
    360,
    containerHeight - topSpacing - controlsTopSpacing - modeToggleReservedHeight - trayReservedHeight,
  );
  const widthFromHeightLimit = Math.floor(maxHeight / rawCardReticleAspectRatio);
  const width = Math.max(284, Math.min(containerWidth - horizontalInset * 2, widthFromHeightLimit));
  const height = Math.round(width * rawCardReticleAspectRatio);
  const x = (containerWidth - width) / 2;
  const y = topSpacing + 16;

  return {
    backButtonTop: safeAreaTop + 2,
    controlsTop: y + height + controlsTopSpacing,
    modeToggleWidth: Math.min(containerWidth - 48, 264),
    previewHeight: containerHeight,
    previewWidth: containerWidth,
    promptTop: Math.max(safeAreaTop + chromeBackButtonSize + 20, y - 36),
    reticle: {
      height,
      width,
      x,
      y,
    },
  };
}

export function RawScannerCaptureSurface({
  cameraRef,
  cameraSessionKey = 0,
  canCapture,
  children,
  hasCameraAccess,
  layout,
  onCameraReady,
  onCapture,
  onRequestPermission,
  permissionCanAskAgain,
  permissionResolved,
  pictureSize,
  prompt,
  showSlabGuide = false,
  testIDPrefix,
}: RawScannerCaptureSurfaceProps) {
  return (
    <View style={styles.previewCanvas}>
      {hasCameraAccess ? (
        <CameraView
          facing="back"
          key={cameraSessionKey}
          onCameraReady={onCameraReady}
          pictureSize={Platform.OS === 'android' ? pictureSize : undefined}
          ref={cameraRef}
          style={StyleSheet.absoluteFillObject}
          testID={`${testIDPrefix}-camera`}
        />
      ) : (
        <View
          style={[StyleSheet.absoluteFillObject, styles.cameraFallback]}
          testID={`${testIDPrefix}-camera-fallback`}
        />
      )}

      {hasCameraAccess ? (
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

      {!hasCameraAccess ? (
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
  reticleCaptureButton: {
    position: 'absolute',
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

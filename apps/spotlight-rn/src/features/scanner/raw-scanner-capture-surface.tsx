import * as FileSystem from 'expo-file-system';
import type { ReactNode, RefObject } from 'react';
import { useImperativeHandle } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  usePhotoOutput,
} from 'react-native-vision-camera';

import {
  colors,
  textStyles,
} from '@spotlight/design-system';

import { chromeBackButtonSize } from '@/components/chrome-back-button';
import { rawCardReticleAspectRatio } from '@/features/scanner/scanner-normalized-target';

export const rawVisualCaptureQuality = 0.62;
export const rawVisualPreferredLongSide = 1280;
export const rawVisualMinimumLongSide = 900;
export const rawScannerTrayReservedHeight = 168;
export const rawScannerModeToggleGap = 8;
export const rawScannerTrayHeaderHeight = 61;
export const rawScannerTrayEmptyPeekHeight = 12;
export const rawScannerTrayCollapsedRowHeight = 102;
export const rawScannerModeToggleReservedHeight = 89;
export const slabLabelDividerRatio = 0.28;
export const slabLabelAnalysisBottomRatio = 0.34;
export const scannerReticleGuideStrokeWidth = 1.7;
export const scannerReticleCornerSize = 22;
export const scannerReticleCornerStrokeWidth = 3;
export const slabGuideHorizontalInset = 8;

/**
 * Imperative handle the scanner screens drive to capture a still. Wraps
 * vision-camera's photo-output capture into the `{ uri, base64, width, height }`
 * shape the downstream normalize pipeline expects.
 */
export type RawScannerCameraHandle = {
  takePicture(opts: { quality: number }): Promise<{
    uri: string;
    base64?: string;
    width: number;
    height: number;
  } | null>;
};

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
  cameraRef: RefObject<RawScannerCameraHandle | null>;
  canCapture: boolean;
  children?: ReactNode;
  hasCameraPermission: boolean;
  isTrayExpanded?: boolean;
  layout: RawScannerCaptureLayout;
  onCameraReady: () => void;
  onCapture: () => void;
  prompt: string;
  shouldMountCamera: boolean;
  showSlabGuide?: boolean;
  testIDPrefix: string;
  /**
   * Nominal magnification multiplier (1 / 1.5 / 2). Multiplied against the
   * device's neutral (1x wide-angle) zoom and clamped to the device's
   * min/max so a far card can fill the reticle with TRUE optical magnification.
   */
  zoomFactor?: number;
};

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
  const maxHeight = Math.max(
    360,
    containerHeight - topSpacing - controlsTopSpacing - rawScannerModeToggleReservedHeight - trayReservedHeight,
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

export function getRawScannerCollapsedTrayReservedHeight({
  bottomInset,
}: {
  bottomInset: number;
}) {
  return rawScannerTrayHeaderHeight + rawScannerTrayCollapsedRowHeight + bottomInset;
}

export function getRawScannerEmptyTrayVisualHeight({
  bottomInset,
}: {
  bottomInset: number;
}) {
  return rawScannerTrayHeaderHeight + rawScannerTrayEmptyPeekHeight + bottomInset;
}

export function RawScannerCaptureSurface({
  cameraRef,
  canCapture,
  children,
  hasCameraPermission,
  isTrayExpanded = false,
  layout,
  onCameraReady,
  onCapture,
  prompt,
  shouldMountCamera,
  showSlabGuide = false,
  testIDPrefix,
  zoomFactor = 1,
}: RawScannerCaptureSurfaceProps) {
  // Prefer the virtual multi-cam device that bundles the ultra-wide. On iOS only
  // these multi-cam devices enable Auto Macro — the automatic switch to the
  // ultra-wide that focuses a close-held card. Single-lens phones fall back to
  // the wide-angle, which getCameraDevice still returns (filter never excludes).
  const device = useCameraDevice('back', {
    physicalDevices: ['ultra-wide-angle', 'wide-angle', 'telephoto'],
  });

  // ~1280 long-side target replaces the old Android picture-size negotiation.
  // The session treats this as a target and may land near it.
  const photoOutput = usePhotoOutput({
    targetResolution: CommonResolutions.HD_16_9,
    quality: rawVisualCaptureQuality,
    qualityPrioritization: 'balanced',
  });

  // True magnification: 1x wide-angle is the neutral baseline for vision-camera
  // (default zoom === 1), so multiply the nominal factor against it and clamp to
  // the device's real optical range.
  const neutralZoom = 1;
  const zoom = device
    ? Math.min(Math.max(neutralZoom * zoomFactor, device.minZoom), device.maxZoom)
    : neutralZoom;

  useImperativeHandle(
    cameraRef,
    () => ({
      // `quality` is honored at the output level via `usePhotoOutput({ quality })`
      // (the Nitro capture settings have no per-call quality knob), so the arg is
      // accepted for the handle contract but the output's quality is what applies.
      async takePicture(_opts) {
        if (!photoOutput) {
          return null;
        }

        const photo = await photoOutput.capturePhoto(
          { flashMode: 'off', enableShutterSound: false },
          {},
        );
        try {
          const path = await photo.saveToTemporaryFileAsync();
          const uri = path.startsWith('file://') ? path : `file://${path}`;

          let base64: string | undefined;
          try {
            base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
          } catch {
            base64 = undefined;
          }

          return {
            uri,
            base64,
            width: photo.width,
            height: photo.height,
          };
        } finally {
          photo.dispose();
        }
      },
    }),
    [photoOutput],
  );

  const isCameraAvailable = shouldMountCamera && hasCameraPermission && device != null;

  return (
    <View style={styles.previewCanvas}>
      {isCameraAvailable ? (
        <Camera
          device={device}
          isActive={shouldMountCamera}
          onStarted={onCameraReady}
          outputs={[photoOutput]}
          style={StyleSheet.absoluteFillObject}
          testID={`${testIDPrefix}-camera`}
          zoom={zoom}
        />
      ) : (
        <View
          style={[StyleSheet.absoluteFillObject, styles.cameraFallback]}
          testID={`${testIDPrefix}-camera-fallback`}
        />
      )}

      {shouldMountCamera && !isTrayExpanded ? (
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


      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        {isTrayExpanded ? null : (
          <Text style={[styles.scanPrompt, { top: layout.promptTop }]} testID={`${testIDPrefix}-prompt`}>
            {prompt}
          </Text>
        )}

        {isTrayExpanded ? null : (
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
                  top: layout.reticle.height * slabLabelDividerRatio,
                },
              ]}
              testID={`${testIDPrefix}-slab-guide`}
            />
          ) : null}

          <View style={[styles.reticleCorner, styles.reticleTopLeftPosition]}>
            <View style={[styles.reticleCornerHorizontal, styles.reticleCornerTopEdge]} />
            <View style={[styles.reticleCornerVertical, styles.reticleCornerLeftEdge]} />
          </View>
          <View style={[styles.reticleCorner, styles.reticleTopRightPosition]}>
            <View style={[styles.reticleCornerHorizontal, styles.reticleCornerTopEdge]} />
            <View style={[styles.reticleCornerVertical, styles.reticleCornerRightEdge]} />
          </View>
          <View style={[styles.reticleCorner, styles.reticleBottomLeftPosition]}>
            <View style={[styles.reticleCornerHorizontal, styles.reticleCornerBottomEdge]} />
            <View style={[styles.reticleCornerVertical, styles.reticleCornerLeftEdge]} />
          </View>
          <View style={[styles.reticleCorner, styles.reticleBottomRightPosition]}>
            <View style={[styles.reticleCornerHorizontal, styles.reticleCornerBottomEdge]} />
            <View style={[styles.reticleCornerVertical, styles.reticleCornerRightEdge]} />
          </View>
        </View>
        )}
      </View>

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  cameraFallback: {
    backgroundColor: colors.scannerCanvas,
  },
  previewCanvas: {
    flex: 1,
    overflow: 'hidden',
  },
  reticleBottomLeftPosition: {
    bottom: 0,
    left: 0,
  },
  reticleBottomRightPosition: {
    bottom: 0,
    right: 0,
  },
  reticleCaptureButton: {
    position: 'absolute',
  },
  reticleCorner: {
    height: scannerReticleCornerSize,
    position: 'absolute',
    width: scannerReticleCornerSize,
  },
  reticleCornerBottomEdge: {
    bottom: 0,
  },
  reticleCornerHorizontal: {
    backgroundColor: colors.brand,
    height: scannerReticleCornerStrokeWidth,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  reticleCornerLeftEdge: {
    left: 0,
  },
  reticleCornerRightEdge: {
    right: 0,
  },
  reticleCornerTopEdge: {
    top: 0,
  },
  reticleCornerVertical: {
    backgroundColor: colors.brand,
    bottom: 0,
    position: 'absolute',
    top: 0,
    width: scannerReticleCornerStrokeWidth,
  },
  reticleShell: {
    borderColor: colors.scannerOutline,
    borderRadius: 14,
    borderWidth: 1,
    position: 'absolute',
  },
  reticleTopLeftPosition: {
    left: 0,
    top: 0,
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
    height: scannerReticleGuideStrokeWidth,
    left: slabGuideHorizontalInset,
    position: 'absolute',
    right: slabGuideHorizontalInset,
  },
});

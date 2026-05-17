import { CameraView } from 'expo-camera';
import type { ReactNode, RefObject } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

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
export const rawScannerTrayCollapsedRowHeight = 88;
export const rawScannerModeToggleReservedHeight = 89;
export const slabLabelDividerRatio = 0.28;
export const slabLabelAnalysisBottomRatio = 0.34;
export const scannerReticleGuideStrokeWidth = 1.7;
export const scannerReticleCornerSize = 22;
export const scannerReticleCornerStrokeWidth = 3;
export const slabGuideHorizontalInset = 8;

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
  availableLensesChanged,
  cameraRef,
  cameraSessionKey = 0,
  canCapture,
  children,
  hasCameraPermission,
  layout,
  onCameraReady,
  onCapture,
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

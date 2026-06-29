// SDK 55: readAsStringAsync lives in /legacy; the new entry's stub throws at
// runtime (silently dropped every scan's source image — see scanner dashboard).
import * as FileSystem from 'expo-file-system/legacy';
import type { ReactNode, RefObject } from 'react';
import { useEffect, useImperativeHandle, useState } from 'react';
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

// Cold-start settle window: when the camera session (re)activates, the lens racks
// focus (continuous AF) for a beat. We hold the SHUTTER (not a visual cover) for
// this long so the first allowed tap lands on a settled, sharp frame. NOT focusTo —
// AF is never disabled; this is just a brief capture gate. Tune on-device. Zero in
// tests so the suite isn't slowed.
const SETTLE_MS = process.env.NODE_ENV === 'test' ? 0 : 700;

export const rawVisualCaptureQuality = 0.62;
export const rawScannerTrayReservedHeight = 168;
export const rawScannerModeToggleGap = 8;
export const rawScannerTrayHeaderHeight = 61;
export const rawScannerTrayEmptyPeekHeight = 12;
export const rawScannerTrayCollapsedRowHeight = 102;
export const rawScannerModeToggleReservedHeight = 89;
// The bottom controls row (scan-target pill + zoom dock, 36px) sits 16px above
// the recent-capture tray. The reticle keeps a uniform 40px gap above this whole
// footer, so reserve its height + that 16px lift when placing the reticle bottom.
export const rawScannerControlsRowHeight = 36;
export const rawScannerControlsRowLift = 16;
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
  // Card-shaped region actually sent to matching. Shares the visible reticle's
  // width and center but keeps the true card aspect, so it extends past the
  // (squatter) visible frame's top/bottom — no crop stretch.
  captureCropRect: {
    height: number;
    width: number;
    x: number;
    y: number;
  };
  controlsTop: number;
  // Height of the grey top scrim/header (Figma 1041-4241: 121pt on a 59pt safe
  // area). The reticle's 40px top padding is measured from its bottom edge.
  headerHeight: number;
  modeToggleWidth: number;
  previewHeight: number;
  previewWidth: number;
  promptTop: number;
  // The VISIBLE framing box (corner brackets + capture hit area).
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
  onCameraError?: (error: unknown) => void;
  onCameraReady: () => void;
  onCameraStopped?: () => void;
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
  // UNIFORM 40px padding on all four sides (Figma 1390-1649 / 1041-4253): the
  // visible frame is inset 40px from the screen edges, 40px below the top chrome,
  // and 40px above the bottom controls row. The frame fills that box (so its shape
  // tracks the device, ~card-shaped on a 393pt phone) — the crop sent to matching
  // is decoupled below to keep the true card aspect.
  const inset = 40;
  const topChromeBottom = safeAreaTop + chromeBackButtonSize + 16;
  // Grey header band (Figma 1041-4241): 121pt tall on a 59pt safe area = the back
  // button (positioned at safeAreaTop+10, 34pt tall) plus 18pt below it. The
  // reticle's top padding is measured from THIS bottom edge.
  const headerHeight = safeAreaTop + chromeBackButtonSize + 28;
  const controlsTopSpacing = 10;
  const trayTop = containerHeight - trayReservedHeight;
  // Top edge of the controls row (pill + zoom), which sits a fixed lift above the
  // tray. The reticle bottom keeps `inset` clearance above it.
  const controlsRowTop = trayTop - rawScannerControlsRowLift - rawScannerControlsRowHeight;
  const x = inset;
  const width = Math.max(284, containerWidth - inset * 2);
  const y = headerHeight + inset;
  const height = Math.max(240, controlsRowTop - inset - y);

  // Crop sent to matching keeps the TRUE card aspect (no stretch): same width and
  // horizontal center as the visible frame, centered vertically on it, so it
  // extends past the (squatter) frame top/bottom to capture the whole card.
  const cropHeight = Math.round(width * rawCardReticleAspectRatio);
  const cropY = Math.round(y + (height - cropHeight) / 2);

  // controlsTop is clamped so it never drops into the tray's reserved band.
  const controlsTop = Math.min(
    y + height + controlsTopSpacing,
    trayTop - rawScannerModeToggleReservedHeight,
  );

  return {
    backButtonTop: safeAreaTop + 10,
    captureCropRect: {
      height: cropHeight,
      width,
      x,
      y: cropY,
    },
    controlsTop,
    headerHeight,
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
  onCameraError,
  onCameraReady,
  onCameraStopped,
  onCapture,
  prompt,
  shouldMountCamera,
  showSlabGuide = false,
  testIDPrefix,
  zoomFactor = 1,
}: RawScannerCaptureSurfaceProps) {
  // Keep the ultra-wide in the lens set: on iPhone, only a multi-cam device that
  // includes the ultra-wide enables Auto-Macro — the close-focus that stops cards
  // held close from blurring on 14/15 Pro. The catch is that with the ultra-wide
  // bundled, vision-camera's zoom=1 is the ultra-wide (~Apple 0.5x), so a naive
  // factor makes "1x" super-wide. v5 dropped `device.neutralZoom`, so we re-anchor
  // below: the normal wide lens sits at ~2x the ultra-wide baseline. Net result —
  // "1x" is the normal wide, 1.5x/2x are real magnification, AND macro still works.
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

  // Detect whether the chosen device bundles the ultra-wide (so zoom=1 is the
  // ultra-wide ~0.5x). `device.physicalDevices` is an array of lens descriptors;
  // handle both string and {type} shapes defensively across vision-camera builds.
  const physicalLensTypes: string[] = Array.isArray(
    (device as { physicalDevices?: unknown } | null)?.physicalDevices,
  )
    ? (device as { physicalDevices: unknown[] }).physicalDevices.map((entry) =>
        typeof entry === 'string' ? entry : String((entry as { type?: string })?.type ?? ''),
      )
    : [];
  const hasUltraWide = physicalLensTypes.some((type) => type.includes('ultra-wide'));
  // Apple's ultra-wide is ~0.5x, so the normal wide lens is ~2x the ultra-wide-anchored
  // zoom baseline. Without the ultra-wide, zoom=1 already IS the wide lens.
  const wideBaseline = hasUltraWide ? 2 : 1;
  const deviceMinZoom = (device as { minZoom?: number } | null)?.minZoom ?? 1;
  const deviceMaxZoom = (device as { maxZoom?: number } | null)?.maxZoom ?? wideBaseline * 16;
  // True magnification anchored to the wide lens: factor 1/1.5/2 → genuine 1x/1.5x/2x.
  const zoom = device
    ? Math.min(Math.max(wideBaseline * zoomFactor, deviceMinZoom), deviceMaxZoom)
    : wideBaseline;

  // Dev-only: confirm on-device that 1x/1.5x/2x map to real magnification and inspect
  // the device's lenses / zoom range. Visible in the Metro / dev-client console.
  const lensesLabel = physicalLensTypes.join(',');
  useEffect(() => {
    if (!__DEV__ || !device) {
      return;
    }
    console.info(
      `[SCANNER ZOOM] factor=${zoomFactor} -> appliedZoom=${zoom.toFixed(3)} | ` +
        `hasUltraWide=${hasUltraWide} baseline=${wideBaseline} ` +
        `min=${(device as { minZoom?: number }).minZoom} max=${(device as { maxZoom?: number }).maxZoom} ` +
        `lenses=[${lensesLabel}]`,
    );
  }, [zoomFactor, zoom, device, hasUltraWide, wideBaseline, lensesLabel]);

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
          {
            flashMode: 'off',
            enableShutterSound: false,
            // Align the captured still's field-of-view to the live preview. The
            // session enables lens distortion correction by default on iOS (a
            // slightly NARROWER FOV with the edges trimmed), but photo capture
            // defaults it OFF — so the still came out WIDER than what the user
            // framed in the reticle, pulling in the cards around the target and
            // matching the wrong one. Correcting the still too makes the captured
            // frame match the preview. (Zoom is a device-level property and
            // already applies to the still; this closes the remaining FOV gap.)
            enableDistortionCorrection: true,
          },
          {},
        );
        // Dev-only: confirm on-device that the captured FOV now matches the
        // preview. Compare these dims/zoom against what the reticle framed; the
        // normalized crop should contain only the target card. Remove once
        // validated on a build.
        if (__DEV__) {
          console.info(
            `[SCANNER CAPTURE] photo=${photo.width}x${photo.height} ` +
              `appliedZoom=${zoom.toFixed(3)} zoomFactor=${zoomFactor}`,
          );
        }
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
    [photoOutput, zoom, zoomFactor],
  );

  // Keep the <Camera> MOUNTED whenever we have a device + permission, and let
  // the `isActive` prop start/stop the capture session as the user pages between
  // the scanner and the portfolio. Conditionally mounting on `shouldMountCamera`
  // tore down and rebuilt the native camera session on every page swipe, which
  // reliably hard-crashed the app on the portfolio->scanner return. This is
  // vision-camera's documented pattern (mount once, toggle isActive) and is what
  // the expo-camera->vision-camera migration intended ("drop the remount hack").
  const isCameraMounted = hasCameraPermission && device != null;

  // Brief capture gate after the camera session (re)activates so the first tap
  // lands on a settled, sharp frame (continuous AF converges in this window).
  // Driven off `shouldMountCamera` (not the camera's `onStarted`, whose inline
  // identity churns) so it re-arms on every (re)activation — app open, swipe-in,
  // foreground return. No visual cover: the live feed shows through.
  const [isSettling, setIsSettling] = useState(false);
  useEffect(() => {
    if (!shouldMountCamera) {
      return;
    }
    setIsSettling(true);
    const timer = setTimeout(() => setIsSettling(false), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [shouldMountCamera]);

  return (
    <View style={styles.previewCanvas}>
      {isCameraMounted ? (
        <Camera
          device={device}
          isActive={shouldMountCamera}
          onError={onCameraError}
          onStarted={onCameraReady}
          onStopped={onCameraStopped}
          // Orient captures to the UI (locked to portrait) rather than the physical
          // device sensor. The default 'device' source rotates output with phone tilt
          // even under screen lock, which let a transitional orientation slip a sideways
          // photo through during reload/init. 'interface' ties output to the locked
          // portrait UI, so every capture is consistently upright.
          orientationSource="interface"
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
          disabled={!canCapture || isSettling}
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

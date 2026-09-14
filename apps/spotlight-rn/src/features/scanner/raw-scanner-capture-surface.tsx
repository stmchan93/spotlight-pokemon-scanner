// SDK 55: readAsStringAsync lives in /legacy; the new entry's stub throws at
// runtime (silently dropped every scan's source image — see scanner dashboard).
import * as FileSystem from 'expo-file-system/legacy';
import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useImperativeHandle, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import Reanimated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  usePhotoOutput,
} from 'react-native-vision-camera';

import { resolveScannerCameraDevice } from '@/features/scanner/scanner-camera-lens';

import {
  Text,
  colors,
  spacing,
  textStyles,
} from '@spotlight/design-system';

import { rawCardReticleAspectRatio } from '@/features/scanner/scanner-normalized-target';

// Cold-start settle window: when the camera session (re)activates, the lens racks
// focus (continuous AF) for a beat. We hold the SHUTTER (not a visual cover) for
// this long so the first allowed tap lands on a settled, sharp frame. NOT focusTo —
// AF is never disabled; this is just a brief capture gate. Tune on-device. Zero in
// tests so the suite isn't slowed.
const SETTLE_MS = process.env.NODE_ENV === 'test' ? 0 : 700;

/**
 * Height the reticle's geometry treats the top chrome as occupying — FROZEN at
 * 34, deliberately.
 *
 * This used to read `chromeBackButtonSize`, which was 34 at the time. That made
 * the SCAN WINDOW a function of a button's diameter: `headerHeight` derives from
 * this and `y = headerHeight + inset` is the reticle's top edge, so restyling
 * chrome silently moved the reticle and changed the crop sent to matching.
 *
 * The scanner does not even render that button (it has its own 32pt bubble). Do
 * NOT re-point this at a styling token; if the capture window should move, move
 * it here on purpose and re-check scan accuracy.
 */
const SCANNER_TOP_CHROME_HEIGHT = 34;

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
/**
 * Resting reticle outline colour — Figma 5085:15171, whose 1px stroke is
 * `Color/purple/200` exactly. Exported so it can be asserted: this frame has
 * gone purple → white → purple and then from four corner brackets to a closed
 * outline, so it drifts, and a value buried in a private `StyleSheet.create` is
 * a value nobody can guard.
 */
export const reticleRestingOutlineColor = colors.purple200;
/** Capture-pulse outline colour — Figma 2227:22140, the "locked" frame. */
export const reticleLockedOutlineColor = colors.purple500;
export const scannerReticleOutlineStrokeWidth = 1;
export const scannerReticleCornerRadius = 12;
export const slabGuideHorizontalInset = 8;

/**
 * Imperative handle the scanner screens drive to capture a still. Wraps
 * vision-camera's photo-output capture into the `{ uri, base64, width, height }`
 * shape the downstream normalize pipeline expects.
 */
export type RawScannerCameraHandle = {
  takePicture(opts: {
    quality: number;
    /**
     * Also read the saved photo back as base64 (a full-resolution ~MB-scale
     * string through the JS thread). Default OFF: the scanner uploads the
     * photo FILE via multipart streaming. Labeling — whose upload payloads are
     * inline base64 — opts in.
     */
    includeBase64?: boolean;
  }): Promise<{
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
  /**
   * 'page' = binder-page mode: a 4K still so each of the nine pocket crops is
   * ~720px wide, above the matcher's 630px input. 'card' = the single-card
   * FHD still (the reticle crop already exceeds 630px there).
   */
  captureResolution?: 'card' | 'page';
  /**
   * Binder-page mode: the pocket grid drawn INSIDE the frame, in the armed
   * layout's columns × rows. Owned here rather than by the screen because the
   * grid has to share the frame's box exactly — see `pageGridLine`.
   */
  pageGrid?: { columns: number; rows: number } | null;
  prompt: string;
  /**
   * Capture "lock-in" pulse (Figma 2227:22138 → 2227:22140): 0 = resting white
   * frame, 1 = frame contracted ~4% with purple corners. The screen owns the
   * value and animates it on capture (same pattern as the shutter flash).
   */
  reticleLockProgress?: SharedValue<number>;
  shouldMountCamera: boolean;
  /**
   * Pause the live session (isActive=false) WITHOUT unmounting the camera —
   * used while a full-screen result overlay covers the preview, so the ISP/AF
   * stop burning CPU behind the blur but reopening is instant.
   */
  suspendPreview?: boolean;
  /**
   * Scan from the ultra-wide lens only (see scanner-camera-lens.ts). Removes
   * the Auto-Macro lens hand-off "snap" on Pro iPhones; ignored where the
   * ultra-wide has no autofocus.
   */
  lockMacroLens?: boolean;
  showSlabGuide?: boolean;
  testIDPrefix: string;
  /**
   * Nominal magnification multiplier (1 / 1.5 / 2). Multiplied against the
   * device's neutral (1x wide-angle) zoom and clamped to the device's
   * min/max so a far card can fill the reticle with TRUE optical magnification.
   */
  zoomFactor?: number;
};

export type RawScannerCaptureLayoutMode = 'card' | 'page';

export function makeRawScannerCaptureLayout({
  containerHeight,
  containerWidth,
  mode = 'card',
  pageAspectRatio = rawCardReticleAspectRatio,
  safeAreaTop,
  trayReservedHeight = rawScannerTrayReservedHeight,
}: {
  containerHeight: number;
  containerWidth: number;
  /**
   * Page mode only: height ÷ width of the page crop (a 3×3 of upright cards
   * shares the single card's aspect; taller layouts are taller). The crop
   * fits INSIDE the usable box — full width when the aspect allows, narrower
   * and centered when the page would otherwise run into the controls.
   */
  pageAspectRatio?: number;
  /**
   * 'page' = binder-page mode. The reticle IS the page detector (the pocket crops
   * are a thirds split of it), so it spans the full usable width to maximise
   * per-pocket pixels, and the visible frame equals the crop rect exactly so the
   * 3×3 grid drawn on screen is the grid that gets cut. 'card' (default) is the
   * single-card layout and is untouched by this flag.
   */
  mode?: RawScannerCaptureLayoutMode;
  safeAreaTop: number;
  trayReservedHeight?: number;
}): RawScannerCaptureLayout {
  // UNIFORM 40px padding on all four sides (Figma 1390-1649 / 1041-4253): the
  // visible frame is inset 40px from the screen edges, 40px below the top chrome,
  // and 40px above the bottom controls row. The frame fills that box (so its shape
  // tracks the device, ~card-shaped on a 393pt phone) — the crop sent to matching
  // is decoupled below to keep the true card aspect.
  const inset = 40;
  const topChromeBottom = safeAreaTop + SCANNER_TOP_CHROME_HEIGHT + 16;
  // Grey header band (Figma 1041-4241): 121pt tall on a 59pt safe area = the back
  // button (positioned at safeAreaTop+10, 34pt tall) plus 18pt below it. The
  // reticle's top padding is measured from THIS bottom edge.
  const headerHeight = safeAreaTop + SCANNER_TOP_CHROME_HEIGHT + 28;
  const controlsTopSpacing = 10;
  const trayTop = containerHeight - trayReservedHeight;
  // Top edge of the controls row (pill + zoom), which sits a fixed lift above the
  // tray. The reticle bottom keeps `inset` clearance above it.
  const controlsRowTop = trayTop - rawScannerControlsRowLift - rawScannerControlsRowHeight;

  // Page mode trims the vertical insets: the frame IS the crop there and every
  // point of height is page width for the taller layouts (a 3 × 4 page needs
  // ~1.86× its width). Single-card keeps the uniform 40.
  const verticalInset = mode === 'page' ? 16 : inset;
  const x = inset;
  const width = Math.max(284, containerWidth - inset * 2);
  const y = headerHeight + verticalInset;
  const height = Math.max(240, controlsRowTop - verticalInset - y);

  // Crop sent to matching keeps the TRUE card aspect (no stretch): same width and
  // horizontal center as the visible frame, centered vertically on it, so it
  // extends past the (squatter) frame top/bottom to capture the whole card.
  // Page mode: the frame IS the crop, so a taller layout must not run into
  // the controls. The 3×3 page keeps its tuned full-width framing (its
  // card-aspect crop already overhangs the box by a few points, deliberately —
  // every pocket pixel counts); any layout taller than THAT is narrowed and
  // centered so it overhangs no further.
  const pageHeightAllowance = Math.max(height, width * rawCardReticleAspectRatio);
  const cropWidth = mode === 'page'
    ? Math.min(width, Math.floor(pageHeightAllowance / pageAspectRatio))
    : width;
  const cropHeight = Math.round(cropWidth * (mode === 'page' ? pageAspectRatio : rawCardReticleAspectRatio));
  const cropX = mode === 'page' ? Math.round(x + (width - cropWidth) / 2) : x;
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
      width: cropWidth,
      x: cropX,
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
  captureResolution = 'card',
  pageGrid = null,
  prompt,
  reticleLockProgress,
  shouldMountCamera,
  suspendPreview = false,
  lockMacroLens = false,
  showSlabGuide = false,
  testIDPrefix,
  zoomFactor = 1,
}: RawScannerCaptureSurfaceProps) {
  // Stable zero-progress fallback so the reticle renders resting-white when the
  // screen doesn't drive a lock pulse (e.g. lightweight tests).
  const idleLockProgress = useSharedValue(0);
  const lockProgress = reticleLockProgress ?? idleLockProgress;
  // Contract to ~the Figma locked frame (361→345 wide ≈ 0.956); scale from
  // center pulls the whole outline inward evenly, and the lilac→purple
  // crossfade rides the same progress so both read as one "lock" gesture.
  // Worklet styles (UI thread) so the pulse can't stall/replay under burst-scan
  // JS load — which is also why the crossfade is two stacked outlines on
  // OPACITY rather than one animated `borderColor`, a prop no native driver
  // can carry.
  const lockShellStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(lockProgress.value, [0, 1], [1, 0.956]) }],
  }));
  const restingOutlineStyle = useAnimatedStyle(() => ({
    opacity: 1 - lockProgress.value,
  }));
  const lockedOutlineStyle = useAnimatedStyle(() => ({
    opacity: lockProgress.value,
  }));
  // Keep the ultra-wide in the lens set: on iPhone, only a multi-cam device that
  // includes the ultra-wide enables Auto-Macro — the close-focus that stops cards
  // held close from blurring on 14/15 Pro. The catch is that with the ultra-wide
  // bundled, vision-camera's zoom=1 is the ultra-wide (~Apple 0.5x), so a naive
  // factor makes "1x" super-wide. v5 dropped `device.neutralZoom`, so we re-anchor
  // below: the normal wide lens sits at ~2x the ultra-wide baseline. Net result —
  // "1x" is the normal wide, 1.5x/2x are real magnification, AND macro still works.
  const multiLensDevice = useCameraDevice('back', {
    physicalDevices: ['ultra-wide-angle', 'wide-angle', 'telephoto'],
  });
  // Macro lens lock: the ultra-wide alone. No lens hand-off means no preview
  // "snap" as a card comes close; the ×2 re-anchor below still lands "1x" on
  // the normal field of view (digitally, off the ultra-wide sensor).
  const ultraWideDevice = useCameraDevice('back', {
    physicalDevices: ['ultra-wide-angle'],
  });
  const device = resolveScannerCameraDevice({
    lockMacroLens,
    multiLensDevice,
    ultraWideDevice,
  });

  // 'balanced' on BOTH platforms. We A/B'd Android 'speed'
  // (CameraX CAPTURE_MODE_MINIMIZE_LATENCY) on 2026-07-19: it roughly HALVED
  // captureMs (~3.3s → ~1.3s median), but corrupted burst captures — an earlier
  // tray row's image got overwritten by a LATER capture's frame (every ~other
  // shot). That's the minimize-latency buffer pool recycling the frame an
  // earlier not-yet-saved Photo still referenced — the same ZSL-family trap that
  // caused wrong matches before (here it surfaces as image-content overwrite, not
  // a stale preview). Correctness outranks shutter latency, so 'speed' is
  // reverted. The remaining Android capture latency is largely 3A convergence on
  // the budget ISP; cutting it further needs a native frame-processor capture
  // pipeline (deep-copy the frame before the pool recycles), not a config toggle.
  // Capture resolution feeds MATCH ACCURACY, not just the preview. The reticle
  // crop is ~65% of the frame width, then resized to the 630px-wide matcher input.
  // At HD (720×1280) the crop is only ~468px → UPSCALED to 630 → soft → the matcher
  // loses the fine detail (set symbols, collector numbers) that separates similar
  // cards. FHD (1080×1920) keeps the crop ~700px → DOWNSCALED to 630 → sharp. iOS
  // negotiated a high-res still under HD already, so pin the higher target on
  // Android only (its CameraX negotiation landed on the low 720 tier this session).
  // Binder-page mode divides the frame by three, so it needs a 4K still or each
  // pocket lands at ~220px and gets upscaled 3x (measured 2026-08-30: every
  // pocket scan logged source=1920x1080 crop=223x312, all low confidence).
  // Both platforms: UHD only in page mode. iOS briefly ran UHD for BOTH modes
  // (to avoid renegotiating the camera session on the Single<->Page toggle),
  // but the "~200ms" estimate was wrong on-device: a 4K 'balanced' still holds
  // the tap lock ~2s per single-card scan (user-reported 2026-08-31, staging
  // OTA). Single-card pays FHD (fast, ZSL-friendly; reticle crop stays >630px);
  // the session renegotiation now happens only on the rare page toggle.
  const photoOutput = usePhotoOutput({
    targetResolution: captureResolution === 'page'
      ? CommonResolutions.UHD_16_9
      // Single-card: EXACTLY the pre-binder resolutions (iOS HD, Android FHD).
      // Telemetry 2026-08-31: FHD on iOS still ran capture_p50 ~740ms and
      // normalize_p50 ~750ms vs the ~370/230ms HD-era baseline.
      : (Platform.OS === 'android' ? CommonResolutions.FHD_16_9 : CommonResolutions.HD_16_9),
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

  useImperativeHandle(
    cameraRef,
    () => ({
      // `quality` is honored at the output level via `usePhotoOutput({ quality })`
      // (the Nitro capture settings have no per-call quality knob), so the arg is
      // accepted for the handle contract but the output's quality is what applies.
      async takePicture(opts) {
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
            // Android burst-capture fix. The back device bundles ultra-wide +
            // wide + telephoto (for the iOS Auto-Macro trick). CameraX's default
            // virtual-device image FUSION then blends several frames from multiple
            // sensors per shot — slow, and during burst hand-motion those frames
            // don't align, so the still comes out motion-blurred/ghosted AND the
            // shutter lags behind the tap. Disabling fusion makes capturePhoto
            // latch ONE frame immediately, timed to the tap. Still 'balanced'
            // (usePhotoOutput) — NOT the reverted ZSL 'speed' path, which served
            // stale pre-tap frames and produced wrong matches. iOS unchanged.
            // (This replaced the takeSnapshot fast path, which read the preview
            // surface too LATE — three rapid taps all resolved to the last card.)
            ...(Platform.OS === 'android' ? { enableVirtualDeviceFusion: false } : null),
          },
          {},
        );
        try {
          const path = await photo.saveToTemporaryFileAsync();
          const uri = path.startsWith('file://') ? path : `file://${path}`;

          // Only labeling asks for inline base64; scans stream the file itself.
          let base64: string | undefined;
          if (opts?.includeBase64) {
            try {
              base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
            } catch {
              base64 = undefined;
            }
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

  // Android throws `CameraControl$OperationCanceledException: Camera is not
  // active` if a non-neutral zoom is applied before the capture session is live
  // — which is exactly what our 1.5x default does on mount. iOS activates
  // synchronously enough to never hit this. So on Android ONLY, hold the zoom at
  // the device default until `onStarted` fires (session active), then apply it.
  // iOS is byte-for-byte unchanged (the guard is false there).
  const [cameraStarted, setCameraStarted] = useState(false);
  const appliedZoom = Platform.OS === 'android' && !cameraStarted ? undefined : zoom;
  const handleCameraStarted = useCallback(() => {
    setCameraStarted(true);
    onCameraReady();
  }, [onCameraReady]);
  const handleCameraStopped = useCallback(() => {
    setCameraStarted(false);
    onCameraStopped?.();
  }, [onCameraStopped]);

  // Android watchdog: rapid isActive flaps (fast tab swipes) can race CameraX
  // into a dead CLOSED state while isActive is still true — no error, no
  // onStarted, shutter gated forever. If the session should be live but hasn't
  // started within the window, force ONE full native remount via key bump
  // (retries every window while still wedged). iOS never hits this and keeps
  // the mount-once pattern untouched.
  const [cameraSessionEpoch, setCameraSessionEpoch] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android' || !shouldMountCamera || cameraStarted) {
      return;
    }
    const timer = setTimeout(() => {
      setCameraSessionEpoch((epoch) => epoch + 1);
    }, 4000);
    return () => clearTimeout(timer);
  }, [shouldMountCamera, cameraStarted, cameraSessionEpoch]);

  // Page mode draws the frame around the CROP rect: the 3x3 grid covers the
  // crop (pockets are cut from it), so the purple corners must wrap the grid
  // rather than the squatter single-card frame inside it.
  const frameRect = captureResolution === 'page' ? layout.captureCropRect : layout.reticle;

  return (
    <View style={styles.previewCanvas}>
      {isCameraMounted ? (
        <Camera
          device={device}
          isActive={shouldMountCamera && !suspendPreview}
          key={`camera-${cameraSessionEpoch}`}
          onError={onCameraError}
          onStarted={handleCameraStarted}
          onStopped={handleCameraStopped}
          // Orient captures to the UI (locked to portrait) rather than the physical
          // device sensor. The default 'device' source rotates output with phone tilt
          // even under screen lock, which let a transitional orientation slip a sideways
          // photo through during reload/init. 'interface' ties output to the locked
          // portrait UI, so every capture is consistently upright.
          orientationSource="interface"
          outputs={[photoOutput]}
          style={StyleSheet.absoluteFillObject}
          testID={`${testIDPrefix}-camera`}
          zoom={appliedZoom}
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
              height: frameRect.height,
              left: frameRect.x,
              top: frameRect.y,
              width: frameRect.width,
            },
          ]}
          testID={`${testIDPrefix}-preview`}
        />
      ) : null}


      <View pointerEvents="none" style={StyleSheet.absoluteFillObject}>
        {isTrayExpanded || !prompt ? null : (
          <Text style={[styles.scanPrompt, { top: layout.promptTop }]} testID={`${testIDPrefix}-prompt`}>
            {prompt}
          </Text>
        )}

        {isTrayExpanded ? null : (
        <Reanimated.View
          style={[
            styles.reticleShell,
            {
              height: frameRect.height,
              left: frameRect.x,
              top: frameRect.y,
              width: frameRect.width,
            },
            lockShellStyle,
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


          {/*
            ONE CLOSED ROUNDED OUTLINE, in single-card mode as well as page mode
            (Figma 5085:15171). It replaced the four L-shaped corner brackets:
            the same frame is now drawn at both scales, so the thirds grid the
            screen paints inside the page reads as one object with its edge
            instead of floating between detached corners.

            The frame's 40% white fill from that node is deliberately NOT drawn.
            Figma composites it over flat artwork; over a live viewfinder it is
            a scrim on the card being scanned, which both washes out what the
            user is aiming at and frosts the very pixels the crop is cut from.

            Resting lilac and the capture-pulse purple crossfade on the shared
            lock progress (opacity + scale only → native driver).
          */}
          <Reanimated.View
            pointerEvents="none"
            style={[styles.reticleOutline, restingOutlineStyle]}
            testID={`${testIDPrefix}-reticle-outline`}
          />
          <Reanimated.View
            pointerEvents="none"
            style={[styles.reticleOutline, styles.reticleOutlineLockedTint, lockedOutlineStyle]}
            testID={`${testIDPrefix}-reticle-lock`}
          />

          {/*
            THE POCKET GRID LIVES INSIDE THE FRAME, and that placement is the
            whole point — it used to be a sibling of this shell, positioned in
            the preview canvas's own coordinates off the same crop rect.

            Two things went wrong with that, both of them "the grid doesn't line
            up with the frame":
              1. the frame's 1px border is drawn INSIDE its box, so dividing the
                 OUTER rect into thirds left the two outer cells a pixel narrower
                 than the middle one, and each line met the border at a seam
                 rather than running into it;
              2. the capture pulse scales THIS shell ~4% (`lockShellStyle`) and a
                 sibling does not ride that transform — so at the exact moment
                 the user is looking hardest, the frame contracted and the grid
                 stayed put.
            Nested here, both are structural: `borderInset` divides the interior
            the border actually leaves behind, and the transform is inherited.
          */}
          {pageGrid ? (
            <View pointerEvents="none" style={styles.pageGrid} testID={`${testIDPrefix}-binder-grid`}>
              {Array.from({ length: pageGrid.columns - 1 }, (_, index) => index + 1).map((column) => (
                <View
                  key={`binder-grid-v${column}`}
                  style={[styles.pageGridLine, {
                    bottom: 0,
                    left: `${(100 / pageGrid.columns) * column}%`,
                    top: 0,
                    width: scannerReticleOutlineStrokeWidth,
                  }]}
                />
              ))}
              {Array.from({ length: pageGrid.rows - 1 }, (_, index) => index + 1).map((row) => (
                <View
                  key={`binder-grid-h${row}`}
                  style={[styles.pageGridLine, {
                    height: scannerReticleOutlineStrokeWidth,
                    left: 0,
                    right: 0,
                    top: `${(100 / pageGrid.rows) * row}%`,
                  }]}
                />
              ))}
            </View>
          ) : null}
        </Reanimated.View>
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
  reticleCaptureButton: {
    position: 'absolute',
  },
  /*
    The reticle frame itself — Figma 5085:15171: a 1px `Color/purple/200`
    stroke on a 12pt continuous-corner rounded rect, drawn edge to edge of the
    shell. `borderCurve` is what keeps the corner reading as Figma's smooth
    squircle rather than iOS's plain circular arc.
  */
  reticleOutline: {
    ...StyleSheet.absoluteFillObject,
    borderColor: reticleRestingOutlineColor,
    borderCurve: 'continuous',
    borderRadius: scannerReticleCornerRadius,
    borderWidth: scannerReticleOutlineStrokeWidth,
  },
  /*
    Capture-pulse tint (Figma 2227:22140 — the "locked" frame).

    The lock is a shift from the pale lilac outline to the saturated brand
    purple. That is a quiet signal on its own, so the pulse leans on the ~4%
    contraction riding the same progress value — see `lockShellStyle`. If the
    lock stops reading on device, deepen THIS colour rather than lightening the
    resting frame; the resting colour is the part Figma specifies.
  */
  reticleOutlineLockedTint: {
    borderColor: reticleLockedOutlineColor,
  },
  /*
    The interior of the frame — the box left over once the 1px border is drawn.
    Insetting by exactly the stroke width is what makes all three cells the same
    width and lands each line flush against the frame it divides.
  */
  pageGrid: {
    ...StyleSheet.absoluteFillObject,
    margin: scannerReticleOutlineStrokeWidth,
  },
  /*
    The thirds lines themselves — the SAME 1px `Color/purple/200` as the frame
    they divide, on purpose, so the frame and its grid read as one object and
    each line runs into the border in the same ink.

    Figma draws these as `Color/purple/50` (5085:15377 vertical / 5085:15380
    horizontal) and we deliberately don't. Two reasons, and neither is taste:
      1. that value is very nearly white, and Figma composites it over a flat
         grey mock. Over a live viewfinder aimed at glossy cards it disappears
         into the highlights exactly when the user needs it to seat a page;
      2. it made the frame dominate and left the 3x3 reading as a faint hint,
         which is a regression from the corner-bracket era this replaced — that
         drew a 2pt purple300 grid, and the grid was the dominant structure.
    Matching the border is the quietest thing that still restores the grid as a
    real object. If it ever needs to shout again, go back to the 2pt weight
    before reaching for a darker colour.
  */
  pageGridLine: {
    backgroundColor: reticleRestingOutlineColor,
    position: 'absolute',
  },
  reticleShell: {
    position: 'absolute',
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

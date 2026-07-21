import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useMemo } from 'react';
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';

/**
 * Result shape every screen-level capture resolves to. Mirrors the
 * `{ uri, base64?, width, height }` contract the normalize pipeline and the
 * simpler photo-attach flows expect, replacing expo-camera's `takePictureAsync`.
 */
export type VisionCameraCaptureResult = {
  uri: string;
  base64?: string;
  width: number;
  height: number;
};

export type VisionCameraCaptureOptions = {
  /**
   * Output JPEG quality (0..1). Applied at the photo-output level because the
   * Nitro per-call capture settings expose no quality knob.
   */
  quality?: number;
  /**
   * Whether to read the saved file back as base64. Off by default so callers
   * that only need a `uri` (e.g. attaching a transaction photo) skip the read.
   */
  includeBase64?: boolean;
};

export type UseVisionCameraCaptureOptions = {
  /** Default output quality for the photo output. */
  quality?: number;
  /**
   * Which camera to use. Defaults to `'back'` (all pre-existing callers).
   * `'front'` selects the selfie camera and skips the multi-cam
   * `physicalDevices` hint — that hint exists so the back ultra-wide can
   * Auto-Macro a close-held card, which has no front-camera equivalent.
   */
  position?: 'back' | 'front';
};

/**
 * Shared vision-camera (v5 / Nitro) capture hook for the simpler standalone
 * camera screens (sales transaction photo, labeling). Encapsulates the back
 * device selection, the camera permission, the photo output, and a `capture()`
 * that wraps `capturePhoto` → `saveToTemporaryFileAsync` → `file://` uri →
 * `dispose()` into the `{ uri, base64?, width, height }` shape callers expect.
 *
 * The full raw scanner adapter (`raw-scanner-capture-surface.tsx`) intentionally
 * keeps its own copy of this recipe; this hook is for the two simpler screens.
 */
export function useVisionCameraCapture({
  quality = 0.72,
  position = 'back',
}: UseVisionCameraCaptureOptions = {}) {
  // Back camera: prefer the virtual multi-cam device that bundles the ultra-wide
  // so iOS Auto Macro can focus a close-held card; single-lens phones fall back
  // to wide. Front camera: no physicalDevices hint — take the default selfie cam.
  const device = useCameraDevice(
    position,
    position === 'back'
      ? { physicalDevices: ['ultra-wide-angle', 'wide-angle', 'telephoto'] }
      : undefined,
  );

  const { hasPermission, requestPermission } = useCameraPermission();

  const photoOutput = usePhotoOutput({
    targetResolution: CommonResolutions.HD_16_9,
    quality,
    qualityPrioritization: 'balanced',
  });

  const capture = useCallback(
    async ({ includeBase64 = false }: VisionCameraCaptureOptions = {}): Promise<VisionCameraCaptureResult | null> => {
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
        if (includeBase64) {
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
    [photoOutput],
  );

  return useMemo(
    () => ({
      /** Best-matching camera device for the requested position, or `undefined` while resolving. */
      device,
      /** Camera component to render the preview. */
      Camera,
      /** Photo output to pass to `<Camera outputs={[photoOutput]} />`. */
      photoOutput,
      /** Whether camera permission is currently granted. */
      hasPermission,
      /**
       * Requests camera permission. Resolves `true` when granted. When it
       * resolves `false`, the OS either denied or can no longer prompt, so the
       * caller should surface a "open Settings" message.
       */
      requestPermission,
      /** Capture a still; resolves `null` if the output is not ready. */
      capture,
    }),
    [device, photoOutput, hasPermission, requestPermission, capture],
  );
}

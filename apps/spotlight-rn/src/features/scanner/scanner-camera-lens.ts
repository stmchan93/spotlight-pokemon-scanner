/**
 * "Macro lens lock" — scan from the ultra-wide lens only.
 *
 * The scanner normally opens the ultra-wide + wide + telephoto virtual device so
 * iOS Auto-Macro can hand a close-held card to the ultra-wide (the main lens on
 * Pro phones can't focus inside ~20cm). That hand-off is what users see as the
 * preview "snapping" or refocusing right as they bring a card in (confirmed at
 * ~15cm on iPhone 14 Pro Max, 2026-09-07). Locking to the ultra-wide removes the
 * switch entirely — the ultra-wide focuses down to ~2cm — at the cost of scanning
 * off a softer sensor, digitally zoomed to the normal field of view.
 *
 * Only worth it where the ultra-wide has autofocus (Pro models). Non-Pro
 * ultra-wides are fixed-focus, so the lock would blur every scan there; the
 * resolver below falls back to the multi-lens device in that case.
 *
 * The scanner always asks for the lock; there is no user-facing setting. Binder
 * pages add `requireHighResolution`: the 2x crop that keeps "1x" framing leaves
 * a 12MP ultra-wide (14/15 Pro) at ~3MP, too soft for nine pocket crops, so
 * pages lock only on a 48MP ultra-wide (16 Pro and later).
 */

// A 48MP sensor reports ~8064x6048 photos; 12MP reports ~4032x3024.
const HIGH_RES_ULTRA_WIDE_MIN_PIXELS = 40_000_000;

type LensCapableDevice = {
  /** vision-camera v5: true when the device can lock focus, i.e. has autofocus. */
  supportsFocusLocking?: boolean;
  supportsFocusMetering?: boolean;
  getSupportedResolutions?: (outputStreamType: 'photo') => { width: number; height: number }[];
};

export function resolveScannerCameraDevice<TDevice extends LensCapableDevice>({
  lockMacroLens,
  requireHighResolution = false,
  multiLensDevice,
  ultraWideDevice,
}: {
  lockMacroLens: boolean;
  requireHighResolution?: boolean;
  multiLensDevice: TDevice | null | undefined;
  ultraWideDevice: TDevice | null | undefined;
}): TDevice | null {
  if (
    lockMacroLens
    && ultraWideDevice
    && ultraWideCanFocus(ultraWideDevice)
    && (!requireHighResolution || maxPhotoPixels(ultraWideDevice) >= HIGH_RES_ULTRA_WIDE_MIN_PIXELS)
  ) {
    return ultraWideDevice;
  }
  return multiLensDevice ?? null;
}

function ultraWideCanFocus(device: LensCapableDevice): boolean {
  return device.supportsFocusLocking === true || device.supportsFocusMetering === true;
}

function maxPhotoPixels(device: LensCapableDevice): number {
  try {
    const sizes = device.getSupportedResolutions?.('photo') ?? [];
    return sizes.reduce((max, size) => Math.max(max, size.width * size.height), 0);
  } catch {
    return 0;
  }
}

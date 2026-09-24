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
 * Nothing turns the lock on today (no settings toggle), so the scanner always
 * uses the multi-lens device.
 */

type LensCapableDevice = {
  /** vision-camera v5: true when the device can lock focus, i.e. has autofocus. */
  supportsFocusLocking?: boolean;
  supportsFocusMetering?: boolean;
};

export function resolveScannerCameraDevice<TDevice extends LensCapableDevice>({
  lockMacroLens,
  multiLensDevice,
  ultraWideDevice,
}: {
  lockMacroLens: boolean;
  multiLensDevice: TDevice | null | undefined;
  ultraWideDevice: TDevice | null | undefined;
}): TDevice | null {
  if (lockMacroLens && ultraWideDevice && ultraWideCanFocus(ultraWideDevice)) {
    return ultraWideDevice;
  }
  return multiLensDevice ?? null;
}

function ultraWideCanFocus(device: LensCapableDevice): boolean {
  return device.supportsFocusLocking === true || device.supportsFocusMetering === true;
}

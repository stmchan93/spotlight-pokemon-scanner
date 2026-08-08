import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';
import { markScanCameraDismissed } from './(tabs)/scan';

/**
 * The camera, PUSHED over the tabs — which is what hides the native tab bar and
 * restores the full-size reticle.
 *
 * ROOT-LEVEL deliberately: under `(tabs)/` expo-router would make it a tab, the
 * bar would render over the viewfinder, and the inset would shrink the reticle
 * again — the exact problem this route exists to undo.
 *
 * Exiting uses `dismissTo('/')` rather than `back()`: `back()` is a plain pop,
 * while `dismissTo` unwinds anything the scanner pushed on top of itself
 * (review sheets, card detail) in one step. With the Scan tab handing its
 * selection back to Collection at launch time — see `(tabs)/scan.tsx` — the two
 * now land in the same place, so this is about robustness, not destination.
 */
export default function ScanCameraRoute() {
  const router = useRouter();

  // Tell the Scan tab launcher that a camera has just gone away.
  //
  // This is an UNMOUNT cleanup rather than a call inside `onExitToPortfolio`
  // precisely because the interactive back-swipe never runs an exit handler —
  // it pops the screen straight out from under us. Unmount is the one signal
  // that the back button, `dismissTo`, and a committed back-swipe all share.
  // (A back-swipe the user CANCELS does not unmount, and correctly does not
  // stamp anything.)
  //
  // The launcher treats a focus arriving right after this stamp as "the user is
  // coming back" instead of "the user wants to scan", which is what stops the
  // pop -> refocus -> push relaunch loop. See the long comment in
  // `(tabs)/scan.tsx` for why the previous two fixes did not hold.
  useEffect(() => markScanCameraDismissed, []);

  return (
    <NativeTabsPageBridge page="scanner">
      <StatusBar style="light" />
      <ScannerScreen onExitToPortfolio={() => router.dismissTo('/' as never)} />
    </NativeTabsPageBridge>
  );
}

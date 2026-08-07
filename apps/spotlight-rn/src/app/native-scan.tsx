import { useRouter } from 'expo-router';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';

/**
 * The camera, pushed full-screen over the native tabs.
 *
 * ROOT-LEVEL ON PURPOSE. It must not live under `native-tabs/`, or expo-router
 * makes it a tab and the native bar draws over the viewfinder — the exact thing
 * this route exists to avoid. Root also means it is pushed on the root Stack, so
 * it gets the native back gesture for free.
 *
 * `onExitToPortfolio` is a plain `back()`. The pager's version had to choose
 * between popping history and sliding pages depending on how the tabs root was
 * reached; a pushed screen has exactly one way out, so that ambiguity is gone
 * rather than ported.
 *
 * `onTopLevelSwipeEnabledChange` is intentionally not passed: it told the pager
 * to stop claiming horizontal swipes, and the stack's back gesture is UIKit's,
 * not something we arbitrate.
 *
 * The bridge reports 'scanner' so `shouldMountCamera` (scanner-screen.tsx:879)
 * turns on here and — because focus flips when this route is popped — turns off
 * when the user leaves.
 */
export default function NativeScanRoute() {
  const router = useRouter();

  return (
    <NativeTabsPageBridge page="scanner">
      <ScannerScreen onExitToPortfolio={() => router.back()} />
    </NativeTabsPageBridge>
  );
}

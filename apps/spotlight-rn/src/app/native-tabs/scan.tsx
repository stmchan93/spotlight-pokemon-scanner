import { useRouter } from 'expo-router';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';

/**
 * Scanner as a native tab.
 *
 * `onTopLevelSwipeEnabledChange` is intentionally NOT passed. It existed so the
 * scanner could tell the pager to stop claiming horizontal swipes; with no pager
 * there is nothing to tell, and stubbing it would imply a contract that no
 * longer has a counterpart.
 *
 * `onExitToPortfolio` becomes a plain tab switch. The pager's version also had
 * to decide between popping navigation history and sliding pages, because the
 * tabs root could be pushed on top of another screen — a native tab bar owns its
 * own switching, so that ambiguity disappears rather than needing to be ported.
 */
export default function NativeTabsScanner() {
  const router = useRouter();

  return (
    <NativeTabsPageBridge page="scanner">
      {/*
        `as never` for the same reason the DM inbox needs it: expo-router's typed
        -route union lives in the GITIGNORED, generated `.expo/types/router.d.ts`,
        which only regenerates while the dev server runs — so a route added since
        the last generation isn't in the union and `tsc --noEmit` rejects it.
        Drop the cast once the map has been regenerated.
      */}
      <ScannerScreen onExitToPortfolio={() => router.push('/native-tabs' as never)} />
    </NativeTabsPageBridge>
  );
}

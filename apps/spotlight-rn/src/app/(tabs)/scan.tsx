import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';

/**
 * Scanner tab. Was a redirect into the pager's scanner page; it is now a real
 * screen, because the pager is gone.
 *
 * `onTopLevelSwipeEnabledChange` is deliberately not passed — it told the pager
 * to stop claiming horizontal swipes, and there is no pager to tell.
 */
export default function ScanRoute() {
  const router = useRouter();

  return (
    <NativeTabsPageBridge page="scanner">
      {/* Dark viewfinder needs light status-bar icons. */}
      <StatusBar style="light" />
      <ScannerScreen onExitToPortfolio={() => router.push('/' as never)} />
    </NativeTabsPageBridge>
  );
}

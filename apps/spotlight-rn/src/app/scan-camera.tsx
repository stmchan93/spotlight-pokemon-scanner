import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';

/**
 * The camera, PUSHED over the tabs — which is what hides the native tab bar and
 * restores the full-size reticle.
 *
 * ROOT-LEVEL deliberately: under `(tabs)/` expo-router would make it a tab, the
 * bar would render over the viewfinder, and the inset would shrink the reticle
 * again — the exact problem this route exists to undo.
 *
 * Exiting uses `dismissTo('/')` rather than `back()`: back() would pop onto the
 * Scan tab launcher, and while that screen handles the case, going straight to
 * Collection avoids the extra hop entirely.
 */
export default function ScanCameraRoute() {
  const router = useRouter();

  return (
    <NativeTabsPageBridge page="scanner">
      <StatusBar style="light" />
      <ScannerScreen onExitToPortfolio={() => router.dismissTo('/' as never)} />
    </NativeTabsPageBridge>
  );
}

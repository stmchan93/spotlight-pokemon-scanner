import { useRouter } from 'expo-router';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { ScannerScreen } from '@/features/scanner/screens/scanner-screen';

/**
 * The camera as the MIDDLE native tab.
 *
 * The bar renders over the viewfinder here — that is inherent to being a tab,
 * not a bug to chase (see `_layout.tsx`). `/native-scan` holds the pushed-route
 * version with a full-bleed camera for comparison.
 *
 * `onExitToPortfolio` switches to the Collection tab rather than calling back():
 * a tab has no history to pop, so back() would leave the tab bar entirely.
 */
export default function NativeTabsScanner() {
  const router = useRouter();

  return (
    <NativeTabsPageBridge page="scanner">
      <ScannerScreen onExitToPortfolio={() => router.push('/native-tabs' as never)} />
    </NativeTabsPageBridge>
  );
}

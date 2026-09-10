import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
import { GuestScannerRedirect } from '@/features/auth/components/guest-scanner-redirect';
import {
  cardDetailPreviewFromInventoryEntry,
  saveCardDetailPreviewFromInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import {
  defaultLaneFromPreview,
  prefetchCardDetail,
} from '@/features/cards/card-detail-prefetch';
import { PortfolioScreen } from '@/features/portfolio/screens/portfolio-screen';
import { useAppServices } from '@/providers/app-providers';
import { useAuth } from '@/providers/auth-provider';

/**
 * Home — your own collection, and the landing surface after login.
 *
 * This screen has been here twice. It was the tabs root originally, moved to
 * `(tabs)/you` when the feed was promoted to Home, and came back when the tabs
 * were reordered so the app opens on your cards again. The feed went the other
 * way and now lives at `(tabs)/social`, last in the bar. Only the routes moved
 * in either direction — `PortfolioScreen` and `FeedScreen` are untouched.
 *
 * `(tabs)/you` and `(tabs)/portfolio` are redirects here, so old links and the
 * "tapped my own name in the feed" navigation still land on the collection.
 *
 * `<StatusBar>` is owned per-screen. The retired pager kept exactly one and
 * flipped it with the active page; with real tabs each screen has to declare its
 * own, or the scanner's "light" style survives onto this light surface and the
 * time/battery/Wi-Fi icons go white-on-white.
 */
export default function HomeRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const { isGuest } = useAuth();

  // Collection is gated for guests, so there is nothing to show them here. Send
  // them to the scanner, which is the whole of the guest experience.
  if (isGuest) {
    return <GuestScannerRedirect />;
  }

  return (
    <NativeTabsPageBridge page="portfolio">
      <StatusBar style="dark" />
      <PortfolioScreen
        onOpenInventoryEntry={(entry) => {
          const preview = cardDetailPreviewFromInventoryEntry(entry);
          prefetchCardDetail(
            spotlightRepository,
            entry.cardId,
            defaultLaneFromPreview(preview),
            preview.largeImageUrl ?? preview.imageUrl,
          );
          router.push({
            pathname: '/cards/[cardId]',
            params: {
              cardId: entry.cardId,
              entryId: entry.id,
              previewId: saveCardDetailPreviewFromInventoryEntry(entry),
            },
          });
        }}
      />
    </NativeTabsPageBridge>
  );
}

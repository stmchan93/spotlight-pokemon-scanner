import { Redirect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { NativeTabsPageBridge } from '@/components/native-tabs-page-bridge';
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
 * You — your own collection, and the last tab in the bar.
 *
 * This screen WAS the tabs root (`(tabs)/index`), back when Collection was the
 * landing surface. Home (the feed) took that slot, so the screen moved here
 * unchanged; only the route moved. `(tabs)/portfolio` redirects here rather than
 * to `/`, so `/portfolio` still means "my collection" and not "the feed".
 *
 * `<StatusBar>` is owned per-screen. The retired pager kept exactly one and
 * flipped it with the active page; with real tabs each screen has to declare its
 * own, or the scanner's "light" style survives onto this light surface and the
 * time/battery/Wi-Fi icons go white-on-white.
 */
export default function YouRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const { isGuest } = useAuth();

  // Collection is gated for guests, so there is nothing to show them here. Send
  // them to the scanner, which is the whole of the guest experience.
  if (isGuest) {
    return <Redirect href={'/scan' as never} />;
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

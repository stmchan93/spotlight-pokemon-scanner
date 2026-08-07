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
 * Collection — the landing tab after login.
 *
 * `<StatusBar>` is owned per-screen now. The pager used to keep exactly one and
 * flip it with the active page; with real tabs each screen has to declare its
 * own, or the scanner's "light" style survives onto this light surface and the
 * time/battery/Wi-Fi icons go white-on-white.
 */
export default function TabsRoot() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();
  const { isGuest } = useAuth();

  // Guests land on the scanner (first-launch experience) — the behaviour the
  // pager got from `initialPage`. Collection is gated for them anyway.
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

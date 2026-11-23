import { useRouter } from 'expo-router';

import { FocusedStatusBar } from '@/components/focused-status-bar';
import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import { saveCardDetailPreviewFromCatalogResult } from '@/features/cards/card-detail-preview-session';
import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import { useAppServices } from '@/providers/app-providers';

/**
 * Search — the second tab (Figma 6642:5964 tab bar). Hosts the same catalog
 * landing `/catalog/search` slides up (`(sheet)/catalog/expansion-browser.tsx`),
 * as a page: nothing to close, so no X and no pull-down. The sheet route stays
 * for deep links and the in-page entry points that still push it.
 *
 * Open to guests (`GUEST_OPEN_TABS`): catalog browsing was already reachable
 * signed-out from the Scanner.
 *
 * MERGE NOTE: once `@/features/catalog/search-surface` lands, replace the body
 * below with `<SearchSurface mode="tab" />` (it owns the Search navigation);
 * keep the `FocusedStatusBar`.
 */
export default function SearchRoute() {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();

  return (
    <>
      {/* Dark, as the `/catalog/search` sheet draws it over the same banner. */}
      <FocusedStatusBar style="dark" />
      <ExpansionBrowserScreen
        dismissStyle="none"
        onOpenCard={(result) => {
          prefetchCardDetail(spotlightRepository, result.cardId, undefined, result.imageUrl);
          router.push({
            pathname: '/cards/[cardId]',
            params: {
              cardId: result.cardId,
              previewId: saveCardDetailPreviewFromCatalogResult(result),
            },
          });
        }}
        onSelectExpansion={(expansion, selectedGame) => {
          router.push({
            pathname: '/catalog/expansion/[expansionId]',
            params: { expansionId: expansion.id, game: selectedGame, name: expansion.name },
          });
        }}
        onViewAll={(section, selectedGame) => {
          router.push({ pathname: '/catalog/game/[game]', params: { game: selectedGame, view: section } });
        }}
      />
    </>
  );
}

import { useRouter } from 'expo-router';

import { prefetchCardDetail } from '@/features/cards/card-detail-prefetch';
import {
  saveCardDetailPreviewFromCatalogResult,
  saveCardDetailPreviewFromForeignInventoryEntry,
} from '@/features/cards/card-detail-preview-session';
import { ExpansionBrowserScreen } from '@/features/catalog/screens/expansion-browser-screen';
import type { SearchMode } from '@/features/catalog/screens/game-sets-screen';
import { useAppServices } from '@/providers/app-providers';

/**
 * Search with its navigation wired: the /catalog/search sheet renders
 * `<SearchSurface mode="sheet" />` and the bottom-bar Search tab
 * `<SearchSurface mode="tab" />`. One place owns where a result, a person or
 * one of their cards goes, so the two entry points cannot drift.
 */
export function SearchSurface({ mode }: { mode: SearchMode }) {
  const router = useRouter();
  const { spotlightRepository } = useAppServices();

  return (
    <ExpansionBrowserScreen
      mode={mode}
      onClose={() => router.back()}
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
      onOpenHolding={(_profile, entry) => {
        // Someone else's copy: a display-only preview, never their entry id —
        // that would open the card page as an UPDATE of their row.
        router.push({
          pathname: '/cards/[cardId]',
          params: {
            cardId: entry.cardId,
            previewId: saveCardDetailPreviewFromForeignInventoryEntry(entry),
          },
        });
      }}
      onOpenProfile={(profile) => {
        const handle = profile.handle?.trim();
        router.push({
          pathname: '/u/[handle]',
          params: {
            handle: handle && handle.length > 0 ? handle : profile.userID,
            userId: profile.userID,
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
        // A pushed route, so back-swipe returns to Search.
        router.push({ pathname: '/catalog/game/[game]', params: { game: selectedGame, view: section } });
      }}
    />
  );
}

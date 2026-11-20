import { DEFAULT_CARD_GAME, type CardGame, type CatalogSearchResult, type ExpansionRecord } from '@spotlight/api-client';

import { GameSetsScreen } from '@/features/catalog/screens/game-sets-screen';

type ExpansionBrowserScreenProps = {
  /** The game the chips start on; Pokémon when absent. */
  initialGame?: CardGame;
  onClose: () => void;
  onSelectExpansion: (expansion: ExpansionRecord, game: CardGame) => void;
  onOpenCard: (result: CatalogSearchResult) => void;
  onOpenAssistant?: () => void;
};

/**
 * Browse Sets. The game grid that used to live here is gone: game chips on
 * the sets list switch games in place (Figma 6552:1913), so this is the same
 * screen as a game's set list, just entered without a game picked.
 */
export function ExpansionBrowserScreen({
  initialGame = DEFAULT_CARD_GAME,
  ...props
}: ExpansionBrowserScreenProps) {
  return <GameSetsScreen game={initialGame} {...props} />;
}

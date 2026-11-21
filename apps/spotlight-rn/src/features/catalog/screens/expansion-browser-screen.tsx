import { DEFAULT_CARD_GAME, type CardGame, type CatalogSearchResult, type ExpansionRecord } from '@spotlight/api-client';

import { GameSetsScreen } from '@/features/catalog/screens/game-sets-screen';

type ExpansionBrowserScreenProps = {
  /** The game the chips start on; Pokémon when absent. */
  initialGame?: CardGame;
  onClose: () => void;
  onSelectExpansion: (expansion: ExpansionRecord, game: CardGame) => void;
  onOpenCard: (result: CatalogSearchResult) => void;
  onOpenAssistant?: () => void;
  onViewAll?: (section: 'sets' | 'sealed', game: CardGame) => void;
};

/**
 * Search's landing (Figma 6597:5654). The game grid that used to live here is
 * gone: game chips switch games in place, so this is the same screen as a
 * game's page, just entered without a game picked.
 */
export function ExpansionBrowserScreen({
  initialGame = DEFAULT_CARD_GAME,
  ...props
}: ExpansionBrowserScreenProps) {
  // Search's landing slides UP, so it closes with X.
  return <GameSetsScreen dismissStyle="close" game={initialGame} {...props} />;
}

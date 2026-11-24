import {
  DEFAULT_CARD_GAME,
  type CardGame,
  type CatalogSearchResult,
  type ExpansionRecord,
  type InventoryCardEntry,
} from '@spotlight/api-client';

import type { UserProfile } from '@/features/auth/auth-models';
import { GameSetsScreen, type SearchMode, type SearchTab } from '@/features/catalog/screens/game-sets-screen';

type ExpansionBrowserScreenProps = {
  /** The game the chips start on; Pokémon when absent. */
  initialGame?: CardGame;
  /**
   * `sheet` (default): the /catalog/search sheet, closed with X.
   * `tab`: the bottom-bar Search tab — Chat pill + bell, no close.
   */
  mode?: SearchMode;
  onClose: () => void;
  onSelectExpansion: (expansion: ExpansionRecord, game: CardGame) => void;
  onOpenCard: (result: CatalogSearchResult) => void;
  /** Ignored in `tab` mode. */
  onViewAll?: (section: 'sets' | 'sealed', game: CardGame | 'all') => void;
  onOpenProfile?: (profile: UserProfile) => void;
  onOpenHolding?: (profile: UserProfile, entry: InventoryCardEntry) => void;
  initialSearchTab?: SearchTab;
  onAskAssistant?: (question: string, game: CardGame | null) => void;
};

/**
 * Search (Figma 6725:9509). Game chips switch games
 * in place, so this is a game's page entered without a game picked, plus the
 * CARDS | PEOPLE tabs and the filter sheet.
 */
export function ExpansionBrowserScreen({
  initialGame = DEFAULT_CARD_GAME,
  mode = 'sheet',
  ...props
}: ExpansionBrowserScreenProps) {
  return (
    <GameSetsScreen
      // The sheet slides UP, so it closes with X (and swipes down to dismiss).
      dismissStyle={mode === 'sheet' ? 'close' : 'back'}
      game={initialGame}
      searchMode={mode}
      {...props}
    />
  );
}

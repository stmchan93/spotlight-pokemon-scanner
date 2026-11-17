import { mockInventoryEntries, type AssistantProposedAction } from '@spotlight/api-client';

import { runAssistantAction, type AssistantActionDeps } from '@/features/assistant/assistant-action-runner';
import { createWatchlistStore } from '@/features/wishlist/watchlist-store';

import { createTestSpotlightRepository } from '../../test-utils';

function deps(overrides: Parameters<typeof createTestSpotlightRepository>[0]): AssistantActionDeps {
  return {
    repository: createTestSpotlightRepository(overrides),
    activeCollectionID: 'all',
    inventoryEntriesCache: mockInventoryEntries,
    prependOptimisticInventoryEntry: jest.fn(),
    removeOptimisticInventoryEntries: jest.fn(),
    refreshData: jest.fn(),
    watchlistStore: createWatchlistStore(),
    cards: [],
  };
}

const conditionChange: AssistantProposedAction = {
  id: 'act_c',
  type: 'update_holding',
  summary: 'Celebi NM → LP',
  state: 'proposed',
  params: { holdingId: 'entry-3', quantity: null, condition: 'LP' },
};

describe('runAssistantAction', () => {
  it('a condition change replaces the holding like the PDP edit sheet and keeps the cost basis', async () => {
    const replacePortfolioEntry = jest.fn(async () => ({
      previousDeckEntryID: 'entry-3', deckEntryID: 'entry-3b', cardID: 'xyp-111', quantity: 1, unitPrice: 20, updatedAt: 'now',
    }));
    const updateDeckEntryCostBasis = jest.fn(async () => ({ deckEntryID: 'entry-3b', cardID: 'xyp-111', costBasisPerUnit: 20, costBasisPerUnitCents: 2000 }));
    const d = deps({ replacePortfolioEntry, updateDeckEntryCostBasis: updateDeckEntryCostBasis as never });

    await expect(runAssistantAction(conditionChange, d)).resolves.toEqual({ status: 'done' });
    expect(replacePortfolioEntry).toHaveBeenCalledWith(expect.objectContaining({
      deckEntryID: 'entry-3', cardID: 'xyp-111', condition: 'lightly_played', quantity: 1, unitPrice: 20,
    }));
    expect(updateDeckEntryCostBasis).toHaveBeenCalledWith({ deckEntryID: 'entry-3b', costBasisPerUnit: 20 });
    expect(d.removeOptimisticInventoryEntries).toHaveBeenCalledWith(['entry-3']);
    expect(d.refreshData).toHaveBeenCalled();
  });

  it('fails cleanly for a holding the user no longer has', async () => {
    const d = deps({ getInventoryEntries: jest.fn(async () => []) });
    const outcome = await runAssistantAction(
      { ...conditionChange, params: { holdingId: 'gone', quantity: 2, condition: null } },
      { ...d, inventoryEntriesCache: null },
    );
    expect(outcome).toEqual({ status: 'failed', message: "That card isn't in your collection anymore." });
  });

  it('reports a failed target as a failure after the watch landed', async () => {
    const d = deps({
      setCardFavorite: jest.fn(async () => ({ cardId: 'xyp-111', isFavorite: true })),
      setCardFavoriteTarget: jest.fn(async () => ({ status: 'failed' as const, target: null })),
    });
    const outcome = await runAssistantAction(
      { id: 'w', type: 'watch_card', summary: '', state: 'proposed', params: { cardId: 'xyp-111', variant: null, targetPriceUsd: 10 } },
      d,
    );
    expect(outcome.status).toBe('failed');
  });
});

import { AssistantRequestError, mockInventoryEntries, type AssistantProposedAction } from '@spotlight/api-client';

import {
  isExecutedAssistantAction,
  runAssistantAction,
  undoExecutedAdd,
  type AssistantActionDeps,
} from '@/features/assistant/assistant-action-runner';
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

describe('undoExecutedAdd', () => {
  const executed: AssistantProposedAction = {
    id: 'act_d',
    type: 'add_to_collection',
    summary: 'Added Celebi · NM · ×2',
    state: 'done',
    params: { cardId: 'xyp-111', quantity: 2, condition: 'NM', variantName: null, grader: null, grade: null, collectionId: null },
    undo: { deckEntryId: 'entry-9', quantityAdded: 2, expiresAt: null },
  };

  it('undoes server-side and refreshes collection data', async () => {
    const undoAssistantAction = jest.fn(async () => ({ ...executed, state: 'undone' as const }));
    const d = deps({ undoAssistantAction });
    const outcome = await undoExecutedAdd(executed, d);
    expect(outcome).toEqual({ status: 'undone', action: { ...executed, state: 'undone' } });
    expect(undoAssistantAction).toHaveBeenCalledWith('act_d');
    expect(d.refreshData).toHaveBeenCalledTimes(1);
  });

  it('maps refusals to copy and does not refresh', async () => {
    const d = deps({
      undoAssistantAction: jest.fn(async () => {
        throw new AssistantRequestError('cannot_undo', 'cannot_undo', 409);
      }),
    });
    await expect(undoExecutedAdd(executed, d)).resolves.toEqual({
      status: 'failed',
      message: "That card isn't in your collection anymore.",
    });
    expect(d.refreshData).not.toHaveBeenCalled();
  });

  it('only server-executed adds count as executed', () => {
    expect(isExecutedAssistantAction(executed)).toBe(true);
    expect(isExecutedAssistantAction({ ...executed, state: 'undone' })).toBe(true);
    expect(isExecutedAssistantAction({ ...executed, state: 'proposed' })).toBe(false);
    expect(isExecutedAssistantAction({ ...executed, state: 'confirmed' })).toBe(false);
  });
});

import { AssistantRequestError, mockInventoryEntries, type AssistantProposedAction } from '@spotlight/api-client';

import {
  isExecutedAssistantAction,
  runAssistantAction,
  undoExecutedAdd,
  type AssistantActionDeps,
} from '@/features/assistant/assistant-action-runner';
import type { ScanTrayAssistantBridge } from '@/features/scanner/scan-tray-assistant-bridge';
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

describe('runAssistantAction — scan tray actions', () => {
  const swap: AssistantProposedAction = {
    id: 'act_s',
    type: 'swap_tray_card',
    summary: 'Swap Charizard ex (151 199/165) → Charizard ex (Obsidian Flames 223/197)',
    state: 'proposed',
    params: { row: 1, rowRef: 'cap-1', fromCardId: 'sv3pt5-199', toCardId: 'sv3-223', toCard: null },
  };
  const add: AssistantProposedAction = {
    id: 'act_a',
    type: 'add_tray_to_collection',
    summary: 'Add 2 scanned cards',
    state: 'proposed',
    params: {
      rows: [
        { row: 1, rowRef: 'cap-1', cardId: 'sv3pt5-199', quantity: 1, condition: 'NM', variantName: null, grader: null, grade: null },
        { row: 2, rowRef: 'cap-2', cardId: 'xyp-111', quantity: 1, condition: null, variantName: null, grader: 'PSA', grade: '10' },
      ],
    },
  };

  function fakeTray(overrides: Partial<ScanTrayAssistantBridge> = {}): ScanTrayAssistantBridge {
    return {
      rows: () => [],
      addRows: jest.fn(async () => ({ status: 'done' as const })),
      swapCard: jest.fn(() => ({ status: 'done' as const })),
      removeRow: jest.fn(() => ({ status: 'done' as const })),
      ...overrides,
    };
  }

  it('applies a swap to the live tray, never touching the collection', async () => {
    const tray = fakeTray();
    const d = { ...deps({}), scanTray: tray };
    await expect(runAssistantAction(swap, d)).resolves.toEqual({ status: 'done' });
    expect(tray.swapCard).toHaveBeenCalledWith(swap.params);
    expect(d.refreshData).not.toHaveBeenCalled();
  });

  it('says so honestly when the scanner (and its tray) is gone', async () => {
    const d = { ...deps({}), scanTray: null };
    await expect(runAssistantAction(swap, d)).resolves.toEqual({
      status: 'failed', message: "That card isn't in your scan tray anymore.",
    });
    await expect(runAssistantAction(add, d)).resolves.toEqual({
      status: 'failed', message: "Those cards aren't in your scan tray anymore.",
    });
  });

  it('passes a row that changed through as a failure, and a partial add as a note', async () => {
    const stale = fakeTray({ swapCard: () => ({ status: 'failed', message: "That card isn't in your scan tray anymore." }) });
    await expect(runAssistantAction(swap, { ...deps({}), scanTray: stale })).resolves.toEqual({
      status: 'failed', message: "That card isn't in your scan tray anymore.",
    });
    const partial = fakeTray({ addRows: jest.fn(async () => ({ status: 'done' as const, note: 'Added 1 of 2.' })) });
    await expect(runAssistantAction(add, { ...deps({}), scanTray: partial })).resolves.toEqual({
      status: 'done', note: 'Added 1 of 2.',
    });
    expect(partial.addRows).toHaveBeenCalledWith(add.params.rows);
  });

  it('removes a row through the tray', async () => {
    const tray = fakeTray();
    const remove: AssistantProposedAction = {
      id: 'act_r', type: 'remove_tray_card', summary: 'Remove', state: 'proposed',
      params: { row: 1, rowRef: 'cap-1', cardId: 'sv3pt5-199' },
    };
    await expect(runAssistantAction(remove, { ...deps({}), scanTray: tray })).resolves.toEqual({ status: 'done' });
    expect(tray.removeRow).toHaveBeenCalledWith(remove.params);
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
